// src/battlemetrics/api.js
// BattleMetrics public API client.
//
// All requests use the public BattleMetrics REST API.
// Set BATTLEMETRICS_API_KEY in .env to authenticate (increases rate limits
// and may unlock additional endpoints).
//
// Endpoints used:
//   GET /servers?filter[game]=rust&filter[search]=<ip>  — find server by IP
//   GET /servers/{id}                                    — server info / player count
//   GET /players?filter[servers]=<id>&filter[online]=true — online players
//   GET /players?filter[search]=<name>&filter[servers]=<id> — search player
//   GET /players/{id}                                    — player profile

'use strict';

const https = require('https');

const BASE_URL = 'https://api.battlemetrics.com';

// ---------------------------------------------------------------------------
// Internal HTTPS helper
// ---------------------------------------------------------------------------

/**
 * Make an authenticated GET request to the BattleMetrics API.
 * @param {string} path  — path + query string (e.g. "/servers?filter[game]=rust")
 * @returns {Promise<object>}
 */
function bmRequest(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);

    const headers = { Accept: 'application/json' };
    const apiKey = process.env.BATTLEMETRICS_API_KEY;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const options = {
      hostname: url.hostname,
      port:     443,
      path:     url.pathname + url.search,
      method:   'GET',
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors && json.errors.length) {
            reject(new Error(json.errors[0].detail || 'BattleMetrics API error'));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`BM JSON parse error: ${data.slice(0, 120)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('BattleMetrics request timed out'));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/**
 * Find a Rust server on BattleMetrics by IP address.
 * Searches by IP string; picks the best match using IP attribute then server name.
 *
 * @param {string} ip         — Rust server IP (e.g. "192.168.1.1")
 * @param {string|null} knownName — optional server name hint for disambiguation
 * @returns {Promise<object|null>} — raw BM server data object, or null if not found
 */
async function findServerByIp(ip, knownName = null) {
  const encoded = encodeURIComponent(ip);
  const json = await bmRequest(
    `/servers?filter[game]=rust&filter[search]=${encoded}&page[size]=10`
  );

  if (!json.data || json.data.length === 0) return null;
  if (json.data.length === 1) return json.data[0];

  // Prefer exact IP attribute match
  const exactIp = json.data.find((s) => s.attributes.ip === ip);
  if (exactIp) return exactIp;

  // Fall back to server name substring match
  if (knownName) {
    const needle = knownName.toLowerCase();
    const nameMatch = json.data.find((s) =>
      (s.attributes.name || '').toLowerCase().includes(needle)
    );
    if (nameMatch) return nameMatch;
  }

  // Return first result
  return json.data[0];
}

/**
 * Get info about a BM server (name, player count, max players, status).
 *
 * @param {string} bmServerId
 * @returns {Promise<{ id, name, players, maxPlayers, status, ip, port }|null>}
 */
async function getServerInfo(bmServerId) {
  const json = await bmRequest(`/servers/${bmServerId}`);
  if (!json.data) return null;
  const attr = json.data.attributes || {};
  return {
    id:         json.data.id,
    name:       attr.name       || 'Unknown',
    players:    attr.players    || 0,
    maxPlayers: attr.maxPlayers || 0,
    status:     attr.status     || 'unknown',
    ip:         attr.ip         || '',
    port:       attr.port       || 0,
  };
}

/**
 * Get currently online players for a BM server.
 * Returns an empty array on error (non-fatal — tracker will retry next poll).
 *
 * @param {string} bmServerId
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
async function getOnlinePlayers(bmServerId) {
  try {
    const json = await bmRequest(
      `/players?filter[servers]=${bmServerId}&filter[online]=true&page[size]=100`
    );
    if (!json.data) return [];
    return json.data.map((p) => ({
      id:   p.id,
      name: (p.attributes && p.attributes.name) || 'Unknown',
    }));
  } catch (e) {
    console.warn('[BattleMetrics] getOnlinePlayers error:', e.message);
    return [];
  }
}

/**
 * Search for a player by name on a specific server.
 *
 * @param {string} name
 * @param {string} bmServerId
 * @returns {Promise<Array<{ id: string, name: string, online: boolean }>>}
 */
async function searchPlayer(name, bmServerId) {
  const encoded = encodeURIComponent(name);
  const json = await bmRequest(
    `/players?filter[search]=${encoded}&filter[servers]=${bmServerId}&page[size]=10`
  );
  if (!json.data) return [];
  return json.data.map((p) => ({
    id:     p.id,
    name:   (p.attributes && p.attributes.name)   || 'Unknown',
    online: !!(p.attributes && p.attributes.online),
  }));
}

/**
 * Get a player's public BM profile by player ID.
 *
 * @param {string} bmPlayerId
 * @returns {Promise<{ id, name, private }|null>}
 */
async function getPlayerProfile(bmPlayerId) {
  const json = await bmRequest(`/players/${bmPlayerId}`);
  if (!json.data) return null;
  const attr = json.data.attributes || {};
  return {
    id:      json.data.id,
    name:    attr.name    || 'Unknown',
    private: !!attr.private,
  };
}

module.exports = {
  findServerByIp,
  getServerInfo,
  getOnlinePlayers,
  searchPlayer,
  getPlayerProfile,
};
