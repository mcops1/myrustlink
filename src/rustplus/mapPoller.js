// src/rustplus/mapPoller.js
// MyRustLink — Map marker poller.
//
// Polls getMapMarkers() every 10 seconds for each active RustPlusConnection
// and tracks the spawn/despawn state of key game events:
//   - Cargo Ship       (AppMarkerType.CargoShip = 5)
//   - Patrol Heli      (AppMarkerType.PatrolHelicopter = 8)
//   - Bradley APC      (AppMarkerType.Explosion = 2)
//   - Oil Rig crate    (AppMarkerType.Crate = 6)
//
// On spawn: emits 'spawn' event on the connection + sends team chat message.
// On despawn: emits 'despawn' event on the connection + sends team chat message.
//
// Public API:
//   startPoller(connection)           — begin polling for this connection
//   stopPoller(connection)            — stop polling for this connection
//   getTimerState(ip, port)           — returns current state object
//   getTimerSummary(ip, port)         — returns human-readable string

'use strict';

// ---------------------------------------------------------------------------
// Marker type constants (from rustplus.proto AppMarkerType enum)
// ---------------------------------------------------------------------------

const MARKER_TYPE = {
  EXPLOSION:         2,  // Bradley APC (and other explosions — filtered by context)
  CARGO_SHIP:        5,  // Cargo Ship
  CRATE:             6,  // Locked Crate (Oil Rig locked crate)
  PATROL_HELICOPTER: 8,  // Patrol Helicopter
};

// ---------------------------------------------------------------------------
// Respawn windows (milliseconds) — used for "next in ~X" estimates
// ---------------------------------------------------------------------------

const RESPAWN_MS = {
  cargo:   1.75 * 60 * 60 * 1000,  // 1h 45min midpoint of 1.5–2h range
  heli:    2.5  * 60 * 60 * 1000,  // 2h 30min midpoint of 2–3h range
  bradley: 30   * 60 * 1000,       // 30 minutes (fixed)
  oilrig:  15   * 60 * 1000,       // 15 minutes after crate despawn
};

// ---------------------------------------------------------------------------
// Poll interval
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 10 * 1000; // 10 seconds

// ---------------------------------------------------------------------------
// Module-level state map
// Keyed by "ip:port", value is the poller state for that connection.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} EventTimer
 * @property {boolean}   active       — true if the marker is currently on the map
 * @property {Date|null} spawnedAt    — when the last spawn was detected
 * @property {Date|null} despawnedAt  — when the last despawn was detected
 */

/**
 * @typedef {object} PollerState
 * @property {NodeJS.Timeout|null} intervalHandle
 * @property {{ cargo: EventTimer, heli: EventTimer, bradley: EventTimer, oilrig: EventTimer }} timers
 */

/** @type {Map<string, PollerState>} */
const pollerMap = new Map();

// ---------------------------------------------------------------------------
// Grid coordinate conversion
// ---------------------------------------------------------------------------

/**
 * Convert Rust map x/y coordinates to a grid reference like "D5".
 * Rust maps use 150-unit grid cells. y=0 is the bottom of the map.
 * @param {number} x
 * @param {number} y
 * @param {number} mapSize  — map width/height in units (e.g. 4000)
 * @returns {string}
 */
function _coordToGrid(x, y, mapSize) {
  if (!mapSize) return '??';
  const cellSize = 150;
  const col = Math.floor(x / cellSize);
  const row = Math.floor((mapSize - y) / cellSize);
  const colLetter = String.fromCharCode(65 + col);
  return `${colLetter}${row + 1}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the canonical connection key.
 * @param {string} ip
 * @param {number} port
 * @returns {string}
 */
function _key(ip, port) {
  return `${ip}:${port}`;
}

/**
 * Create a fresh blank EventTimer object.
 * @returns {EventTimer}
 */
function _blankTimer() {
  return { active: false, spawnedAt: null, despawnedAt: null };
}

/**
 * Format a Date to a 12-hour time string with am/pm.
 * e.g. "3:07pm"
 * @param {Date} date
 * @returns {string}
 */
function _formatTime(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '(unknown)';
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const mm = String(minutes).padStart(2, '0');
  return `${hours}:${mm}${ampm}`;
}

/**
 * Format a duration in milliseconds as "Xh Ymin" or just "Ymin".
 * @param {number} ms
 * @returns {string}
 */
function _formatDuration(ms) {
  if (ms <= 0) return '0min';
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const mins  = totalMinutes % 60;
  if (hours > 0 && mins > 0) return `${hours}h ${mins}min`;
  if (hours > 0) return `${hours}h`;
  return `${mins}min`;
}

/**
 * Send a team chat message safely through the connection's RustPlus client.
 * Swallows any error to prevent crashes.
 * @param {import('./index.js').RustPlusConnection} connection
 * @param {string} text
 */
function _safeSendTeamMessage(connection, text) {
  try {
    if (!connection.isConnected()) return;
    const client = connection.getClient();
    if (!client) return;
    client.sendTeamMessage(text);
  } catch (err) {
    console.warn(`[MapPoller] sendTeamMessage failed (${connection.serverIp}:${connection.serverPort}): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core poll tick
// ---------------------------------------------------------------------------

/**
 * Perform one poll tick: call getMapMarkers and update state.
 * @param {import('./index.js').RustPlusConnection} connection
 * @param {PollerState} state
 */
function _tick(connection, state) {
  if (!connection.isConnected()) {
    console.log(`[MapPoller] Skipping tick — not connected (${connection.serverIp}:${connection.serverPort})`);
    return;
  }

  const client = connection.getClient();
  if (!client) return;

  client.getMapMarkers((message) => {
    try {
      // Guard: check for error response
      if (message.response && message.response.error) {
        console.warn(
          `[MapPoller] getMapMarkers error (${connection.serverIp}:${connection.serverPort}):`,
          message.response.error.error || message.response.error
        );
        return;
      }

      // Extract markers array from response
      const mapMarkers = message.response && message.response.mapMarkers;
      if (!mapMarkers) {
        console.warn(`[MapPoller] No mapMarkers in response (${connection.serverIp}:${connection.serverPort})`);
        return;
      }

      const markers = mapMarkers.markers || [];

      // Determine presence of each tracked entity
      const cargoPresent   = markers.some((m) => m.type === MARKER_TYPE.CARGO_SHIP);
      const heliPresent    = markers.some((m) => m.type === MARKER_TYPE.PATROL_HELICOPTER);
      const bradleyPresent = markers.some((m) => m.type === MARKER_TYPE.EXPLOSION);
      const oilrigPresent  = markers.some((m) => m.type === MARKER_TYPE.CRATE);

      // Process each tracked event
      _processEvent(connection, state.timers.cargo,   'cargo',   cargoPresent);
      _processEvent(connection, state.timers.heli,    'heli',    heliPresent);
      _processEvent(connection, state.timers.bradley, 'bradley', bradleyPresent);
      _processEvent(connection, state.timers.oilrig,  'oilrig',  oilrigPresent);

    } catch (err) {
      console.error(
        `[MapPoller] Error processing markers (${connection.serverIp}:${connection.serverPort}):`,
        err.message
      );
    }
  });
}

/**
 * Compare current map presence to last known state and emit events/messages on changes.
 * @param {import('./index.js').RustPlusConnection} connection
 * @param {EventTimer} timer
 * @param {string} eventName  — 'cargo' | 'heli' | 'bradley' | 'oilrig'
 * @param {boolean} nowPresent  — true if the marker is on the map right now
 */
function _processEvent(connection, timer, eventName, nowPresent) {
  if (nowPresent && !timer.active) {
    // ---- SPAWN ----
    timer.active     = true;
    timer.spawnedAt  = new Date();

    const msg = _spawnMessage(eventName);
    _safeSendTeamMessage(connection, msg);
    console.log(`[MapPoller] SPAWN detected: ${eventName} (${connection.serverIp}:${connection.serverPort})`);

    /**
     * @event RustPlusConnection#spawn
     * @type {{ event: string, spawnedAt: Date }}
     */
    connection.emit('spawn', { event: eventName, spawnedAt: timer.spawnedAt });

  } else if (!nowPresent && timer.active) {
    // ---- DESPAWN ----
    timer.active      = false;
    timer.despawnedAt = new Date();

    const msg = _despawnMessage(eventName);
    _safeSendTeamMessage(connection, msg);
    console.log(`[MapPoller] DESPAWN detected: ${eventName} (${connection.serverIp}:${connection.serverPort})`);

    /**
     * @event RustPlusConnection#despawn
     * @type {{ event: string, despawnedAt: Date }}
     */
    connection.emit('despawn', { event: eventName, despawnedAt: timer.despawnedAt });
  }
  // No change — do nothing
}

// ---------------------------------------------------------------------------
// Message strings
// ---------------------------------------------------------------------------

/** @param {string} eventName */
function _spawnMessage(eventName) {
  switch (eventName) {
    case 'cargo':   return '\uD83D\uDEA2 Cargo Ship has spawned!';
    case 'heli':    return '\uD83D\uDE81 Patrol Helicopter is incoming!';
    case 'bradley': return '\uD83D\uDCA5 Bradley APC is active at Launch Site!';
    case 'oilrig':  return '\uD83D\uDEE2\uFE0F Oil Rig is locked! Scientists called.';
    default:        return `${eventName} has spawned!`;
  }
}

/** @param {string} eventName */
function _despawnMessage(eventName) {
  switch (eventName) {
    case 'cargo':   return '\uD83D\uDEA2 Cargo Ship has left the map.';
    case 'heli':    return '\uD83D\uDE81 Patrol Helicopter has been destroyed or left.';
    case 'bradley': return '\uD83D\uDCA5 Bradley APC has been destroyed. Respawns in ~30 min.';
    case 'oilrig':  return '\uD83D\uDEE2\uFE0F Oil Rig crate has been looted or timed out.';
    default:        return `${eventName} has despawned.`;
  }
}

// ---------------------------------------------------------------------------
// Timer summary helpers
// ---------------------------------------------------------------------------

/**
 * Build a status line for a single event timer.
 * @param {string} eventName  — 'cargo' | 'heli' | 'bradley' | 'oilrig'
 * @param {EventTimer} timer
 * @returns {string}
 */
function _timerLine(eventName, timer) {
  const icon = {
    cargo:   '\uD83D\uDEA2',
    heli:    '\uD83D\uDE81',
    bradley: '\uD83D\uDCA5',
    oilrig:  '\uD83D\uDEE2\uFE0F',
  }[eventName] || '';

  const label = {
    cargo:   'Cargo',
    heli:    'Heli',
    bradley: 'Bradley',
    oilrig:  'Oil Rig',
  }[eventName] || eventName;

  if (timer.active) {
    const since = timer.spawnedAt ? ` (spawned at ${_formatTime(timer.spawnedAt)})` : '';
    return `${icon} ${label}: **ACTIVE**${since}`;
  }

  if (timer.despawnedAt) {
    const respawnMs  = RESPAWN_MS[eventName];
    const elapsed    = Date.now() - timer.despawnedAt.getTime();
    const remaining  = respawnMs - elapsed;

    const downAt = _formatTime(timer.despawnedAt);

    if (remaining > 0) {
      return `${icon} ${label}: down at ${downAt} — next in ~${_formatDuration(remaining)}`;
    } else {
      return `${icon} ${label}: down at ${downAt} — may have already respawned`;
    }
  }

  return `${icon} ${label}: unknown (bot wasn't running at last despawn)`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start polling map markers for a given connection.
 * If polling is already active for this connection, it is restarted.
 *
 * @param {import('./index.js').RustPlusConnection} connection
 */
function startPoller(connection) {
  const key = _key(connection.serverIp, connection.serverPort);

  // Stop any existing poller for this key before starting a new one
  if (pollerMap.has(key)) {
    stopPoller(connection);
  }

  const state = {
    intervalHandle: null,
    mapSize: 0,
    timers: {
      cargo:   _blankTimer(),
      heli:    _blankTimer(),
      bradley: _blankTimer(),
      oilrig:  _blankTimer(),
    },
  };

  pollerMap.set(key, state);

  state.intervalHandle = setInterval(() => {
    _tick(connection, state);
  }, POLL_INTERVAL_MS);

  // Fetch map size once after connection settles — used for grid coordinate conversion
  setTimeout(() => {
    if (!pollerMap.has(key)) return;
    const client = connection.getClient();
    if (!client) return;
    client.getMap((msg) => {
      try {
        if (msg.response && msg.response.map && msg.response.map.width) {
          state.mapSize = msg.response.map.width;
        }
      } catch (e) { /* ignore */ }
    });
  }, 3000);

  // Run first tick immediately (after a short delay to allow connection to settle)
  setTimeout(() => {
    if (pollerMap.has(key)) {
      _tick(connection, state);
    }
  }, 2000);

  console.log(`[MapPoller] Started for ${key} (poll interval: ${POLL_INTERVAL_MS}ms)`);
}

/**
 * Stop polling map markers for a given connection.
 *
 * @param {import('./index.js').RustPlusConnection} connection
 */
function stopPoller(connection) {
  const key = _key(connection.serverIp, connection.serverPort);
  const state = pollerMap.get(key);

  if (!state) return;

  if (state.intervalHandle !== null) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
  }

  pollerMap.delete(key);
  console.log(`[MapPoller] Stopped for ${key}`);
}

/**
 * Get the current timer state for a connection.
 * Returns null if no poller has been started for this connection.
 *
 * @param {string} ip
 * @param {number} port
 * @returns {{ cargo: EventTimer, heli: EventTimer, bradley: EventTimer, oilrig: EventTimer }|null}
 */
function getTimerState(ip, port) {
  const state = pollerMap.get(_key(ip, port));
  return state ? state.timers : null;
}

/**
 * Get a human-readable summary of all 4 event timers for a connection.
 * Returns a string with one line per event, formatted for Discord.
 *
 * @param {string} ip
 * @param {number} port
 * @returns {string}
 */
function getTimerSummary(ip, port) {
  const timers = getTimerState(ip, port);

  if (!timers) {
    return 'No map poller active for this server. The bot may still be connecting.';
  }

  const lines = [
    _timerLine('cargo',   timers.cargo),
    _timerLine('heli',    timers.heli),
    _timerLine('bradley', timers.bradley),
    _timerLine('oilrig',  timers.oilrig),
  ];

  return lines.join('\n');
}

/**
 * Get a single-event status message suitable for team chat.
 * @param {string} eventName  — 'cargo' | 'heli' | 'bradley' | 'oilrig'
 * @param {EventTimer} timer
 * @returns {string}
 */
function getSingleTimerMessage(eventName, timer) {
  const icon = {
    cargo:   '\uD83D\uDEA2',
    heli:    '\uD83D\uDE81',
    bradley: '\uD83D\uDCA5',
    oilrig:  '\uD83D\uDEE2\uFE0F',
  }[eventName] || '';

  const label = {
    cargo:   'Cargo',
    heli:    'Heli',
    bradley: 'Bradley',
    oilrig:  'Oil Rig',
  }[eventName] || eventName;

  if (timer.active) {
    const since = timer.spawnedAt ? ` (spawned at ${_formatTime(timer.spawnedAt)})` : '';
    return `${icon} ${label} is currently ACTIVE on the map!${since}`;
  }

  if (timer.despawnedAt) {
    const respawnMs = RESPAWN_MS[eventName];
    const elapsed   = Date.now() - timer.despawnedAt.getTime();
    const remaining = respawnMs - elapsed;

    const timeStr = _formatTime(timer.despawnedAt);

    if (remaining > 0) {
      return `${icon} ${label} despawned at ${timeStr} — next spawn in ~${_formatDuration(remaining)}`;
    } else {
      return `${icon} ${label} despawned at ${timeStr} — may have already respawned`;
    }
  }

  return `${icon} ${label}: unknown — bot hasn't seen it despawn yet`;
}

// ---------------------------------------------------------------------------
// Live crate status query
// ---------------------------------------------------------------------------

/**
 * Query the live map for locked crate markers and return a status message.
 * Calls getMapMarkers() in real-time rather than relying on cached timer state.
 * Calls back with a string message suitable for team chat.
 *
 * @param {import('./index.js').RustPlusConnection} connection
 * @param {function(string): void} callback
 */
function getLiveCrateStatus(connection, callback) {
  if (!connection.isConnected()) {
    return callback('🛢️ Oil Rig: not connected to server.');
  }

  const client = connection.getClient();
  if (!client) return callback('🛢️ Oil Rig: client unavailable.');

  const key = _key(connection.serverIp, connection.serverPort);
  const state = pollerMap.get(key);
  const mapSize = state ? state.mapSize : 0;

  client.getMapMarkers((message) => {
    try {
      if (message.response && message.response.error) {
        return callback('🛢️ Oil Rig: unable to query map right now.');
      }

      const markers = (message.response && message.response.mapMarkers && message.response.mapMarkers.markers) || [];
      const crates = markers.filter((m) => m.type === MARKER_TYPE.CRATE);

      if (crates.length === 0) {
        return callback('🛢️ No locked crates active on the map.');
      }

      const lines = crates.map((crate, i) => {
        const grid = _coordToGrid(crate.x || 0, crate.y || 0, mapSize);
        const label = crates.length > 1 ? `Oil Rig Locked Crate #${i + 1}` : 'Oil Rig Locked Crate';
        return `🛢️ ${label} active @ ${grid}`;
      });

      callback(lines.join(' | '));
    } catch (err) {
      callback('🛢️ Oil Rig: error reading map markers.');
    }
  });
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  startPoller,
  stopPoller,
  getTimerState,
  getTimerSummary,
  getSingleTimerMessage,
  getLiveCrateStatus,
  // Exported for testing
  MARKER_TYPE,
  RESPAWN_MS,
};
