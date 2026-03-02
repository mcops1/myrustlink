// src/battlemetrics/tracker.js
// BattleMetrics player tracker.
//
// Polls the BM API every 60 seconds to detect when tracked players join or
// leave the server. Sends alerts to both Rust team chat and the linked
// Discord channel.
//
// Exports:
//   startTracker(connection)         — begin tracking for a connection
//   stopTracker(connection)          — stop tracking for a connection
//   getBmServerId(ip, port)          — look up cached BM server ID
//   findAndCacheBmServer(connection) — resolve + persist the BM server ID

'use strict';

const { findServerByIp, getOnlinePlayers } = require('./api');
const { db }                               = require('../db');

const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds

/** Map<"ip:port", NodeJS.Timer> — active poll intervals */
const trackerIntervals = new Map();

/** Map<bmServerId, Set<bmPlayerId>> — previous tick's online player set */
const playerCache = new Map();

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function getBmServerRow(serverIp, serverPort) {
  return db.prepare(
    'SELECT * FROM bm_servers WHERE rust_server_ip = ? AND rust_server_port = ?'
  ).get(serverIp, serverPort);
}

// ---------------------------------------------------------------------------
// Find & cache BM server ID for a connection
// ---------------------------------------------------------------------------

/**
 * Look up the BattleMetrics server entry for a Rust+ connection.
 * If not already cached in bm_servers, queries the BM API and persists the result.
 *
 * @param {object} connection — RustPlusConnection instance
 * @returns {Promise<object|null>} — bm_servers DB row, or null if not found
 */
async function findAndCacheBmServer(connection) {
  const { serverIp, serverPort } = connection;

  const existing = getBmServerRow(serverIp, serverPort);
  if (existing) return existing;

  // Try to find a matching server name hint from pairings
  const pairing = db.prepare(
    'SELECT rust_server_name FROM server_pairings WHERE rust_server_ip = ? AND rust_server_port = ?'
  ).get(serverIp, serverPort);
  const knownName = (pairing && pairing.rust_server_name) || null;

  console.log(`[BattleMetrics] Searching BM for server at ${serverIp}...`);

  let bmServer;
  try {
    bmServer = await findServerByIp(serverIp, knownName);
  } catch (e) {
    console.error('[BattleMetrics] API search error:', e.message);
    return null;
  }

  if (!bmServer) {
    console.warn(`[BattleMetrics] No BM entry found for ${serverIp}`);
    return null;
  }

  db.prepare(`
    INSERT INTO bm_servers (rust_server_ip, rust_server_port, bm_server_id, bm_server_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(rust_server_ip, rust_server_port) DO UPDATE SET
      bm_server_id   = excluded.bm_server_id,
      bm_server_name = excluded.bm_server_name,
      last_updated   = CURRENT_TIMESTAMP
  `).run(serverIp, serverPort, bmServer.id, bmServer.attributes.name || '');

  console.log(`[BattleMetrics] Mapped to "${bmServer.attributes.name}" (ID: ${bmServer.id})`);
  return getBmServerRow(serverIp, serverPort);
}

// ---------------------------------------------------------------------------
// Notification helpers
// ---------------------------------------------------------------------------

/**
 * Send an alert to team chat and Discord channel.
 *
 * @param {object} connection — RustPlusConnection
 * @param {string} teamMsg    — message text for Rust team chat
 * @param {function} buildEmbed — (EmbedBuilder) => EmbedBuilder — builds Discord embed
 */
async function notify(connection, teamMsg, buildEmbed) {
  // Rust team chat
  try {
    const rustClient = connection.getClient();
    if (rustClient && connection._isConnected) {
      rustClient.sendTeamMessage(teamMsg);
    }
  } catch (e) {
    console.warn('[BattleMetrics] Team chat send failed:', e.message);
  }

  // Discord embed
  try {
    const { client }     = require('../bot');
    const { EmbedBuilder } = require('discord.js');
    const channelId = connection.channelId;
    if (!channelId || !client || !client.isReady()) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    await channel.send({ embeds: [buildEmbed(EmbedBuilder)] });
  } catch (e) {
    console.warn('[BattleMetrics] Discord send failed:', e.message);
  }
}

async function handlePlayerJoin(connection, bmServerId, player) {
  const tracked = db.prepare(
    'SELECT * FROM tracked_players WHERE bm_server_id = ? AND bm_player_id = ?'
  ).get(bmServerId, player.id);
  if (!tracked) return;

  db.prepare('UPDATE tracked_players SET is_online = 1 WHERE id = ?').run(tracked.id);
  console.log(`[BattleMetrics] Tracked player joined: ${player.name}`);

  await notify(
    connection,
    `\uD83D\uDFE2 [TRACK] ${player.name} joined the server`,
    (E) => new E()
      .setColor(0x57f287)
      .setTitle('\uD83D\uDFE2 Tracked Player Joined')
      .setDescription(`**${player.name}** is now online`)
      .setFooter({ text: 'BattleMetrics Tracker' })
      .setTimestamp()
  );
}

async function handlePlayerLeave(connection, bmServerId, player) {
  const tracked = db.prepare(
    'SELECT * FROM tracked_players WHERE bm_server_id = ? AND bm_player_id = ?'
  ).get(bmServerId, player.id);
  if (!tracked) return;

  db.prepare('UPDATE tracked_players SET is_online = 0 WHERE id = ?').run(tracked.id);
  console.log(`[BattleMetrics] Tracked player left: ${player.name}`);

  await notify(
    connection,
    `\uD83D\uDD34 [TRACK] ${player.name} left the server`,
    (E) => new E()
      .setColor(0xed4245)
      .setTitle('\uD83D\uDD34 Tracked Player Left')
      .setDescription(`**${player.name}** went offline`)
      .setFooter({ text: 'BattleMetrics Tracker' })
      .setTimestamp()
  );
}

// ---------------------------------------------------------------------------
// Poll tick
// ---------------------------------------------------------------------------

async function pollPlayers(connection) {
  const bmRow = getBmServerRow(connection.serverIp, connection.serverPort);
  if (!bmRow) return;

  const bmServerId = bmRow.bm_server_id;
  const players    = await getOnlinePlayers(bmServerId); // already non-throwing

  const onlineNow  = new Set(players.map((p) => p.id));
  const playerById = new Map(players.map((p) => [p.id, p]));
  const prev       = playerCache.get(bmServerId) || new Set();

  // Detect joins
  for (const id of onlineNow) {
    if (!prev.has(id)) {
      await handlePlayerJoin(connection, bmServerId, playerById.get(id));
    }
  }

  // Detect leaves
  for (const id of prev) {
    if (!onlineNow.has(id)) {
      // Retrieve name from tracked_players (may not be tracked — ignored by handler)
      const row  = db.prepare(
        'SELECT player_name FROM tracked_players WHERE bm_server_id = ? AND bm_player_id = ?'
      ).get(bmServerId, id);
      const name = row ? row.player_name : 'Unknown';
      await handlePlayerLeave(connection, bmServerId, { id, name });
    }
  }

  playerCache.set(bmServerId, onlineNow);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start polling BM for a Rust+ connection.
 * Safe to call multiple times — guard prevents duplicate intervals.
 *
 * @param {object} connection — RustPlusConnection
 */
async function startTracker(connection) {
  const key = `${connection.serverIp}:${connection.serverPort}`;
  if (trackerIntervals.has(key)) return;

  const bmRow = await findAndCacheBmServer(connection);
  if (!bmRow) {
    console.warn(`[BattleMetrics] Tracker NOT started for ${key} — BM server not found`);
    return;
  }

  // Prime the cache silently (no join/leave notifications on first tick)
  try {
    const initial = await getOnlinePlayers(bmRow.bm_server_id);
    playerCache.set(bmRow.bm_server_id, new Set(initial.map((p) => p.id)));
    console.log(
      `[BattleMetrics] Tracker started for ${key} | "${bmRow.bm_server_name}" | ` +
      `${initial.length} players online`
    );
  } catch (e) {
    console.warn('[BattleMetrics] Initial poll error:', e.message);
    playerCache.set(bmRow.bm_server_id, new Set());
  }

  const interval = setInterval(() => pollPlayers(connection), POLL_INTERVAL_MS);
  trackerIntervals.set(key, interval);
}

/**
 * Stop polling BM for a connection.
 *
 * @param {object} connection — RustPlusConnection
 */
function stopTracker(connection) {
  const key      = `${connection.serverIp}:${connection.serverPort}`;
  const interval = trackerIntervals.get(key);
  if (interval) {
    clearInterval(interval);
    trackerIntervals.delete(key);
    console.log(`[BattleMetrics] Tracker stopped for ${key}`);
  }
}

/**
 * Return the cached BM server ID for a given Rust server, or null.
 *
 * @param {string} serverIp
 * @param {number} serverPort
 * @returns {string|null}
 */
function getBmServerId(serverIp, serverPort) {
  const row = getBmServerRow(serverIp, serverPort);
  return row ? row.bm_server_id : null;
}

module.exports = {
  startTracker,
  stopTracker,
  getBmServerId,
  findAndCacheBmServer,
};
