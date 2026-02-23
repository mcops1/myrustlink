// src/rustplus/broadcaster.js
// MyRustLink — Game event broadcaster.
//
// Attaches event listeners to a RustPlusConnection instance that automatically
// send Rust+ team chat messages for key game events:
//
//   alarmTriggered   → "🚨 Alarm: [name] has been triggered!"
//   storageUpdated   → "⚠️ [name] is almost full! ([items] / [capacity] slots)"
//                      (fires only when fill ratio crosses the 90% threshold)
//
// The /switch Discord command handles the switch-toggled broadcast directly in
// src/bot/index.js to include the Discord username; we do not duplicate it here.
//
// Usage:
//   const { wireBroadcasters } = require('./broadcaster.js');
//   wireBroadcasters(connection, db);
//
// wireBroadcasters is idempotent — calling it twice on the same connection is
// a no-op (guarded by connection._broadcastersWired).

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Storage fill ratio that triggers the "almost full" broadcast (0.9 = 90%). */
const STORAGE_FULL_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// Helper — device name lookup
// ---------------------------------------------------------------------------

/**
 * Look up a device's display name from the devices table.
 * Falls back to String(entityId) on any error or missing row.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} entityId
 * @param {string}        serverIp
 * @returns {string}
 */
function getDeviceName(db, entityId, serverIp) {
  try {
    const row = db
      .prepare('SELECT name FROM devices WHERE entity_id = ? AND rust_server_ip = ?')
      .get(String(entityId), serverIp);
    return row && row.name ? row.name : String(entityId);
  } catch {
    return String(entityId);
  }
}

// ---------------------------------------------------------------------------
// Helper — safe sendTeamMessage wrapper
// ---------------------------------------------------------------------------

/**
 * Send a team chat message via the RustPlus client.
 * Silently logs and swallows any error so a failed broadcast never crashes the
 * connection manager or command handlers.
 *
 * @param {import('../rustplus/index.js').RustPlusConnection} connection
 * @param {string} text
 */
function safeSendTeamMessage(connection, text) {
  try {
    if (!connection.isConnected()) {
      console.warn(`[Broadcaster] Not connected to ${connection.serverIp}:${connection.serverPort} — skipping team message: "${text}"`);
      return;
    }
    const rustClient = connection.getClient();
    if (!rustClient) {
      console.warn(`[Broadcaster] No RustPlus client available for ${connection.serverIp}:${connection.serverPort} — skipping team message: "${text}"`);
      return;
    }
    rustClient.sendTeamMessage(text);
    console.log(`[Broadcaster] Team message sent (${connection.serverIp}:${connection.serverPort}): ${text}`);
  } catch (err) {
    console.error(`[Broadcaster] sendTeamMessage failed (${connection.serverIp}:${connection.serverPort}): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Wire automatic team-chat broadcast listeners onto a RustPlusConnection.
 *
 * Idempotent: if called a second time on the same connection the function
 * returns immediately without adding duplicate listeners.
 *
 * @param {import('./index.js').RustPlusConnection} connection
 *   A RustPlusConnection instance (extends EventEmitter, exposes .serverIp,
 *   .getClient(), and .isConnected()).
 * @param {import('better-sqlite3').Database} db
 *   The better-sqlite3 db instance used for device name lookups.
 */
function wireBroadcasters(connection, db) {
  // --- IDEMPOTENCY GUARD ---
  // Prevent attaching duplicate listeners if wireBroadcasters is called more
  // than once on the same connection instance (e.g. from both createConnection
  // and a later /setup call).
  if (connection._broadcastersWired) {
    console.log(`[Broadcaster] Already wired for ${connection.serverIp}:${connection.serverPort} — skipping.`);
    return;
  }
  connection._broadcastersWired = true;

  const serverIp = connection.serverIp;

  // --- ADDED: Alarm event handler ---
  // Listen for alarmTriggered events emitted by RustPlusConnection._emitAlarmTriggered.
  // Payload: { entityId: number, name: null }
  // name is always null in the broadcast; we resolve it from the devices table.
  connection.on('alarmTriggered', (payload) => {
    const name = getDeviceName(db, payload.entityId, serverIp);
    safeSendTeamMessage(connection, `\uD83D\uDEA8 Alarm: ${name} has been triggered!`);
  });

  // --- ADDED: Storage monitor threshold handler ---
  // Listen for storageUpdated events emitted by RustPlusConnection._emitStorageUpdated.
  // Payload: { entityId: number, name: null, items: Array, capacity: number }
  //
  // We track per-entity "was already above threshold" state so the message fires
  // only when the fill ratio CROSSES 90% from below, not on every update while
  // the container stays above 90%. This prevents message spam on storage events
  // that fire repeatedly while the box remains nearly full.
  //
  // The state map is keyed by entityId and lives for the lifetime of this closure.
  const storageAboveThreshold = new Map(); // entityId (string) → boolean

  connection.on('storageUpdated', (payload) => {
    const { entityId, items, capacity } = payload;

    // Guard against divide-by-zero for containers with unknown capacity
    if (!capacity || capacity <= 0) return;

    const fillRatio     = items.length / capacity;
    const entityKey     = String(entityId);
    const wasAbove      = storageAboveThreshold.get(entityKey) || false;
    const isAboveNow    = fillRatio >= STORAGE_FULL_THRESHOLD;

    // Update the tracked state for this entity
    storageAboveThreshold.set(entityKey, isAboveNow);

    // Only broadcast when transitioning from below threshold to at/above threshold
    if (isAboveNow && !wasAbove) {
      const name = getDeviceName(db, entityId, serverIp);
      safeSendTeamMessage(
        connection,
        `\u26A0\uFE0F ${name} is almost full! (${items.length} / ${capacity} slots)`
      );
    }
  });

  console.log(`[Broadcaster] Listeners wired for ${serverIp}:${connection.serverPort}`);
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  wireBroadcasters,
  // Exported for unit testing convenience
  getDeviceName,
  STORAGE_FULL_THRESHOLD,
};
