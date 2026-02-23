// src/db/index.js
// SQLite database setup using better-sqlite3.
// Creates the DB file at ./data/myrustlink.db and runs migrations on import.

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Ensure the data directory exists
const dataDir = path.resolve(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'myrustlink.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema migrations — run on every startup (CREATE TABLE IF NOT EXISTS)
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    steam_id         TEXT PRIMARY KEY,
    player_name      TEXT,
    rust_plus_token  TEXT,
    fcm_token        TEXT,
    fcm_credentials  TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS server_pairings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_steam_id       TEXT,
    rust_server_ip      TEXT,
    rust_server_port    INTEGER,
    rust_server_name    TEXT,
    discord_guild_id    TEXT,
    discord_channel_id  TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_steam_id) REFERENCES users(steam_id)
  );

  CREATE TABLE IF NOT EXISTS devices (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_steam_id     TEXT,
    entity_id         TEXT,
    device_type       TEXT,
    name              TEXT,
    rust_server_ip    TEXT,
    rust_server_port  INTEGER,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_steam_id) REFERENCES users(steam_id)
  );

  CREATE TABLE IF NOT EXISTS event_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    steam_id    TEXT,
    event_type  TEXT,
    message     TEXT,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

console.log(`[DB] Database initialised at ${dbPath}`);

// ---------------------------------------------------------------------------
// Helper functions (stubs — no business logic)
// ---------------------------------------------------------------------------

/**
 * Log an event to the event_logs table.
 * @param {string} steamId
 * @param {string} eventType
 * @param {string} message
 */
function logEvent(steamId, eventType, message) {
  const stmt = db.prepare(
    'INSERT INTO event_logs (steam_id, event_type, message) VALUES (?, ?, ?)'
  );
  return stmt.run(steamId, eventType, message);
}

/**
 * Retrieve the most recent events from event_logs.
 * @param {number} limit - Number of rows to return (default 50)
 * @returns {Array}
 */
function getRecentEvents(limit = 50) {
  const stmt = db.prepare(
    'SELECT * FROM event_logs ORDER BY timestamp DESC LIMIT ?'
  );
  return stmt.all(limit);
}

/**
 * Retrieve all server pairings for a given Steam ID.
 * @param {string} steamId
 * @returns {Array}
 */
function getPairings(steamId) {
  const stmt = db.prepare(
    'SELECT * FROM server_pairings WHERE user_steam_id = ? ORDER BY created_at DESC'
  );
  return stmt.all(steamId);
}

/**
 * Retrieve all devices for a given Steam ID.
 * @param {string} steamId
 * @returns {Array}
 */
function getDevices(steamId) {
  const stmt = db.prepare(
    'SELECT * FROM devices WHERE user_steam_id = ? ORDER BY created_at DESC'
  );
  return stmt.all(steamId);
}

/**
 * Look up a user by Steam ID.
 * @param {string} steamId
 * @returns {Object|undefined}
 */
function getUser(steamId) {
  const stmt = db.prepare('SELECT * FROM users WHERE steam_id = ?');
  return stmt.get(steamId);
}

module.exports = {
  db,
  logEvent,
  getRecentEvents,
  getPairings,
  getDevices,
  getUser,
};
