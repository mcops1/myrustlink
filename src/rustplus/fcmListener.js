// src/rustplus/fcmListener.js
// MyRustLink — Automatic FCM pairing listener.
//
// Listens for Rust+ server pairing push notifications via FCM (Firebase Cloud
// Messaging). When a pairing notification arrives, it automatically:
//   1. Updates the user's rust_plus_token in the database
//   2. Re-establishes the RustPlus WebSocket connection with the new token
//      (if a server_pairing row exists for that IP:port)
//
// Prerequisites:
//   - Run `npx @liamcottle/rustplus.js fcm-register` to generate rustplus.config.json
//   - The rustplus.config.json file must exist in the project root directory
//
// FCM push notifications from Rust+ are unencrypted and arrive via the
// PushReceiverClient 'ON_DATA_RECEIVED' event. The notification body is a
// JSON string with fields: ip, port, playerId, playerToken, name, etc.

'use strict';

const path = require('path');
const fs   = require('fs');
const { EventEmitter } = require('events');

// PushReceiverClient is bundled inside the rustplus.js package's own nested
// node_modules tree (it is NOT hoisted to the project root node_modules).
// We resolve it via a relative path from this file's location to avoid a
// MODULE_NOT_FOUND error when Node looks in the top-level node_modules.
const PushReceiverClient = require(
  '../../node_modules/@liamcottle/rustplus.js/node_modules/@liamcottle/push-receiver/src/client'
);

const { db, logEvent } = require('../db/index.js');
const { createConnection, removeConnection } = require('./index.js');

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Path to the FCM credentials config file written by fcm-register */
const CONFIG_PATH = path.join(process.cwd(), 'rustplus.config.json');

/** The active PushReceiverClient instance, or null when not listening */
let _fcmClient = null;

/** Whether the listener is currently active (connected or connecting) */
let _isListening = false;

/**
 * Internal EventEmitter that external modules can subscribe to for FCM events.
 * Emits: 'pairingReceived' with { steamId, ip, port, playerToken, serverName }
 */
const fcmEvents = new EventEmitter();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse the rustplus.config.json file.
 * Returns null if the file does not exist or cannot be parsed.
 * @returns {Object|null}
 */
function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Handle a Rust+ server pairing notification received from FCM.
 *
 * Expected notification body structure (JSON string):
 *   { ip, port, playerId, playerToken, name, ... }
 *
 * @param {Object} data — raw ON_DATA_RECEIVED payload from PushReceiverClient
 */
function handlePairingNotification(data) {
  // The notification body arrives as a JSON string in data.rawData
  // or in appData as a key-value object. In the Rust+ companion app flow
  // the payload is in data.rawData as a JSON string.
  let body;
  try {
    const rawData = data.rawData || data.body || '';
    body = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
  } catch (parseErr) {
    console.warn('[FCM] Could not parse notification body:', parseErr.message);
    return;
  }

  const ip          = body.ip;
  const port        = parseInt(body.port, 10);
  const steamId     = String(body.playerId || '');
  const playerToken = String(body.playerToken || '');
  const serverName  = body.name || `${ip}:${port}`;

  if (!ip || isNaN(port) || !steamId || !playerToken) {
    console.warn('[FCM] Pairing notification missing required fields:', body);
    return;
  }

  console.log(`[FCM] Pairing received for server ${serverName} (${ip}:${port}) — updating token for steamId=${steamId}`);

  // -------------------------------------------------------------------------
  // Step 1: Update the token in the users table
  // -------------------------------------------------------------------------
  try {
    db.prepare('UPDATE users SET rust_plus_token = ? WHERE steam_id = ?')
      .run(playerToken, steamId);

    console.log(`[FCM] Pairing received for server ${serverName} (${ip}:${port}) — token updated`);

    logEvent(steamId, 'fcm_pairing', JSON.stringify({
      server: `${ip}:${port}`,
      serverName,
      time: new Date().toISOString(),
    }));
  } catch (dbErr) {
    console.error('[FCM] DB error updating rust_plus_token:', dbErr.message);
    return;
  }

  // -------------------------------------------------------------------------
  // Resolve Discord routing env vars — warn if missing but continue
  // -------------------------------------------------------------------------
  const guildId   = process.env.DISCORD_GUILD_ID   || '';
  const channelId = process.env.DISCORD_CHANNEL_ID || '';

  if (!guildId || !channelId) {
    console.warn(
      '[FCM] DISCORD_GUILD_ID or DISCORD_CHANNEL_ID not set in environment. ' +
      'Server pairing will be created without Discord channel routing.'
    );
  }

  // -------------------------------------------------------------------------
  // Step 2: Check if a server_pairing exists for this ip:port + guild
  // -------------------------------------------------------------------------
  let existingPairing = null;
  try {
    existingPairing = db.prepare(
      'SELECT * FROM server_pairings WHERE rust_server_ip = ? AND rust_server_port = ? AND discord_guild_id = ?'
    ).get(ip, port, guildId);
  } catch (dbErr) {
    console.error('[FCM] DB error checking server_pairings:', dbErr.message);
  }

  if (existingPairing) {
    // Pairing exists — reconnect with the updated token
    console.log(`[FCM] Existing pairing found for ${ip}:${port} — reconnecting with new token...`);
  } else {
    // No pairing — insert a new server_pairing row
    try {
      db.prepare(`
        INSERT INTO server_pairings
          (user_steam_id, rust_server_ip, rust_server_port, rust_server_name, discord_guild_id, discord_channel_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(steamId, ip, port, serverName, guildId, channelId);

      console.log(`[FCM] Auto-paired server ${serverName} (${ip}:${port}) → Discord guild ${guildId} channel ${channelId}`);

      logEvent(steamId, 'fcm_auto_paired', JSON.stringify({
        server: `${ip}:${port}`,
        serverName,
        guildId,
        channelId,
        time: new Date().toISOString(),
      }));

      // Fetch the newly inserted row so connection uses its ids
      existingPairing = db.prepare(
        'SELECT * FROM server_pairings WHERE rust_server_ip = ? AND rust_server_port = ? AND discord_guild_id = ?'
      ).get(ip, port, guildId);
    } catch (dbErr) {
      console.error('[FCM] DB error inserting server_pairing:', dbErr.message);
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Remove old connection (if any) then create a fresh one
  // -------------------------------------------------------------------------
  try {
    removeConnection(ip, port);
  } catch (removeErr) {
    console.warn('[FCM] Error removing old connection:', removeErr.message);
  }

  try {
    createConnection({
      steamId:     steamId,
      playerToken: Number(playerToken),
      server: {
        ip:   ip,
        port: port,
      },
      guildId:   (existingPairing && existingPairing.discord_guild_id)   || undefined,
      channelId: (existingPairing && existingPairing.discord_channel_id) || undefined,
    });
    console.log(`[FCM] Connection established for ${ip}:${port}`);
  } catch (connErr) {
    console.error('[FCM] Error creating connection after FCM pairing:', connErr.message);
  }

  // -------------------------------------------------------------------------
  // Step 4: Emit event for web dashboard / other subscribers
  // -------------------------------------------------------------------------
  fcmEvents.emit('pairingReceived', {
    steamId,
    ip,
    port,
    playerToken,
    serverName,
    hasPairing: !!existingPairing,
  });
}

/**
 * Process a raw ON_DATA_RECEIVED event from PushReceiverClient.
 * Filters to only Rust+ server pairing notifications before dispatching.
 *
 * @param {Object} data — raw notification data from PushReceiverClient
 */
function onDataReceived(data) {
  try {
    // Rust+ server pairing notifications are identified by their category and type.
    // The appData is a key-value array: [{ key, value }, ...]
    // We look for type === 'server' and category === 'com.facepunch.rust.companion'
    const appDataMap = {};
    if (Array.isArray(data.appData)) {
      for (const entry of data.appData) {
        if (entry.key) {
          appDataMap[entry.key] = entry.value;
        }
      }
    } else if (data.appData && typeof data.appData === 'object') {
      Object.assign(appDataMap, data.appData);
    }

    const category = appDataMap['category'] || data.category || '';
    const type     = appDataMap['type']     || data.type     || '';

    // Filter: only handle Rust+ server pairing notifications
    if (category !== 'com.facepunch.rust.companion' || type !== 'server') {
      // Not a Rust+ server pairing — log at debug level and skip
      console.log(`[FCM] Notification received (category=${category}, type=${type}) — not a server pairing, skipping`);
      return;
    }

    // Merge appDataMap into data for handlePairingNotification to use
    const enrichedData = Object.assign({}, data, appDataMap);
    handlePairingNotification(enrichedData);
  } catch (err) {
    console.error('[FCM] Error processing notification:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the FCM push notification listener.
 *
 * Reads FCM credentials from rustplus.config.json. If the file does not exist
 * (user has not run fcm-register yet), logs a warning and returns without
 * crashing.
 *
 * Safe to call multiple times — if already listening, does nothing.
 *
 * @returns {Promise<void>}
 */
async function startFcmListener() {
  if (_isListening) {
    console.log('[FCM] Listener already active — skipping start');
    return;
  }

  const config = readConfig();

  if (!config) {
    console.warn(
      '[FCM] rustplus.config.json not found at ' + CONFIG_PATH + '. ' +
      'Run `npx @liamcottle/rustplus.js fcm-register` to generate it. ' +
      'FCM pairing listener will not start.'
    );
    return;
  }

  if (!config.fcm_credentials || !config.fcm_credentials.gcm) {
    console.warn(
      '[FCM] rustplus.config.json is missing fcm_credentials.gcm — ' +
      'please re-run `npx @liamcottle/rustplus.js fcm-register`. ' +
      'FCM pairing listener will not start.'
    );
    return;
  }

  const androidId      = config.fcm_credentials.gcm.androidId;
  const securityToken  = config.fcm_credentials.gcm.securityToken;

  if (!androidId || !securityToken) {
    console.warn('[FCM] FCM credentials incomplete (missing androidId or securityToken). FCM listener will not start.');
    return;
  }

  console.log('[FCM] Starting FCM push notification listener...');

  try {
    _fcmClient = new PushReceiverClient(androidId, securityToken, []);

    _fcmClient.on('ON_DATA_RECEIVED', onDataReceived);

    _fcmClient.on('connect', () => {
      console.log('[FCM] Connected to FCM — listening for Rust+ pairing notifications');
    });

    _fcmClient.on('disconnect', () => {
      console.log('[FCM] Disconnected from FCM (will auto-retry)');
    });

    // The client auto-retries on disconnect — we just need to call connect once
    await _fcmClient.connect();

    _isListening = true;
    console.log('[FCM] FCM listener active');
  } catch (err) {
    console.error('[FCM] Failed to start FCM listener:', err.message || err);
    _fcmClient = null;
    _isListening = false;
  }
}

/**
 * Stop the FCM push notification listener and clean up.
 * Safe to call even if the listener was never started.
 */
function stopFcmListener() {
  if (!_fcmClient) {
    return;
  }

  console.log('[FCM] Stopping FCM listener...');

  try {
    _fcmClient.destroy();
  } catch (err) {
    console.warn('[FCM] Error during FCM client destroy:', err.message);
  }

  _fcmClient   = null;
  _isListening = false;

  console.log('[FCM] FCM listener stopped');
}

/**
 * Returns whether the FCM listener is currently active.
 * @returns {boolean}
 */
function isFcmListening() {
  return _isListening;
}

/**
 * Returns whether rustplus.config.json exists in the project root.
 * @returns {boolean}
 */
function hasFcmConfig() {
  return fs.existsSync(CONFIG_PATH);
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  startFcmListener,
  stopFcmListener,
  isFcmListening,
  hasFcmConfig,
  fcmEvents,
};
