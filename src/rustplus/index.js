// src/rustplus/index.js
// MyRustLink — Rust+ WebSocket connection manager.
//
// Manages one RustPlus WebSocket connection per server (keyed by ip:port).
// Each connection instance extends EventEmitter and re-emits typed game events:
//   teamChat, alarmTriggered, switchChanged, storageUpdated, connected, disconnected
//
// Automatic exponential-backoff reconnection is built in and stops after
// maxRetries consecutive failures (default: 10).
//
// Entity type detection:
//   The rustplus.js 'message' broadcast for entityChanged carries a payload
//   but NOT the entity type (Switch/Alarm/StorageMonitor). We use the payload
//   shape to disambiguate:
//     - payload.items present          → StorageMonitor  → storageUpdated
//     - payload.value is boolean only  → Switch OR Alarm
//       The entity type cache (populated via getEntityInfo responses that the
//       manager issues on first connect) refines this. Until the cache is
//       populated, value-based entities emit BOTH switchChanged AND alarmTriggered
//       when value === true, and only switchChanged otherwise.
//
// Safe for multiple simultaneous server connections — each RustPlusConnection
// instance is fully self-contained.

'use strict';

const { EventEmitter } = require('events');
const RustPlus = require('@liamcottle/rustplus.js');
const { logEvent, db } = require('../db/index.js');

// --- ADDED: Event broadcaster (alarm + storage threshold → team chat) ---
const { wireBroadcasters } = require('./broadcaster.js');

// --- ADDED: Map marker poller (cargo / heli / bradley / oil rig timers) ---
const { startPoller, stopPoller } = require('./mapPoller.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Entity type IDs as defined in rustplus.proto AppEntityType enum */
const ENTITY_TYPE = {
  SWITCH: 1,
  ALARM: 2,
  STORAGE_MONITOR: 3,
};

/** Reconnection configuration defaults */
const RECONNECT_DEFAULTS = {
  initialDelayMs: 5000,   // 5 seconds before first retry
  backoffMultiplier: 1.5, // multiply delay on each consecutive failure
  maxDelayMs: 60000,      // cap at 60 seconds
  maxRetries: 10,         // stop after this many consecutive failures
};

// ---------------------------------------------------------------------------
// Connection registry (the module-level Map)
// ---------------------------------------------------------------------------

/**
 * Global map of active RustPlusConnection instances.
 * Key format: "ip:port" (e.g. "192.168.1.1:28082")
 * @type {Map<string, RustPlusConnection>}
 */
const connections = new Map();

// ---------------------------------------------------------------------------
// Helper — safe non-blocking DB log
// ---------------------------------------------------------------------------

/**
 * Write an event_log row without throwing. DB errors are console-logged only.
 * better-sqlite3 is synchronous but very fast; we call it directly (no await).
 * If this ever becomes a bottleneck it can be wrapped in setImmediate.
 *
 * @param {string} steamId
 * @param {string} eventType
 * @param {string|object} data  — will be JSON.stringify'd if object
 */
function safeLog(steamId, eventType, data) {
  try {
    const message = typeof data === 'string' ? data : JSON.stringify(data);
    logEvent(steamId, eventType, message);
  } catch (err) {
    console.error('[RustPlus][DB] Failed to write event log:', err.message);
  }
}

// ---------------------------------------------------------------------------
// RustPlusConnection class
// ---------------------------------------------------------------------------

/**
 * Manages a single authenticated WebSocket connection to a Rust game server.
 * Extends EventEmitter so callers can subscribe to typed game events.
 *
 * @fires RustPlusConnection#connected
 * @fires RustPlusConnection#disconnected
 * @fires RustPlusConnection#reconnecting
 * @fires RustPlusConnection#reconnectFailed
 * @fires RustPlusConnection#error
 * @fires RustPlusConnection#teamChat
 * @fires RustPlusConnection#alarmTriggered
 * @fires RustPlusConnection#switchChanged
 * @fires RustPlusConnection#storageUpdated
 */
class RustPlusConnection extends EventEmitter {

  /**
   * @param {object}  config
   * @param {string}  config.steamId        — Steam ID of the authenticating player
   * @param {number}  config.playerToken    — Rust+ player token from pairing
   * @param {object}  config.server
   * @param {string}  config.server.ip      — Rust server IP address
   * @param {number}  config.server.port    — Rust server app port (typically 28082)
   * @param {string}  [config.guildId]      — Discord guild ID (stored for context)
   * @param {string}  [config.channelId]    — Discord channel ID (stored for context)
   * @param {object}  [config.reconnect]    — Override reconnection settings
   * @param {number}  [config.reconnect.initialDelayMs]
   * @param {number}  [config.reconnect.backoffMultiplier]
   * @param {number}  [config.reconnect.maxDelayMs]
   * @param {number}  [config.reconnect.maxRetries]
   */
  constructor(config) {
    super();

    // Validate required fields
    if (!config || !config.steamId || !config.playerToken || !config.server) {
      throw new Error('[RustPlusConnection] config must include steamId, playerToken, and server { ip, port }');
    }
    if (!config.server.ip || !config.server.port) {
      throw new Error('[RustPlusConnection] config.server must include ip and port');
    }

    this.steamId    = String(config.steamId);
    this.playerToken = config.playerToken;
    this.serverIp   = config.server.ip;
    this.serverPort = config.server.port;
    this.guildId    = config.guildId || null;
    this.channelId  = config.channelId || null;

    // Merge reconnect options with defaults
    const rc = Object.assign({}, RECONNECT_DEFAULTS, config.reconnect || {});
    this._initialDelayMs     = rc.initialDelayMs;
    this._backoffMultiplier  = rc.backoffMultiplier;
    this._maxDelayMs         = rc.maxDelayMs;
    this._maxRetries         = rc.maxRetries;

    // Internal state
    this._rustplus          = null;  // RustPlus client instance
    this._intentionalClose  = false; // true when disconnect() was called by us
    this._reconnectAttempt  = 0;     // consecutive failure counter
    this._reconnectTimer    = null;  // pending setTimeout handle
    this._isConnected       = false; // tracks live connection state

    /**
     * Entity type cache: entityId (number) → ENTITY_TYPE constant (number).
     * Populated whenever getEntityInfo responses arrive via the 'message' handler.
     * @type {Map<number, number>}
     */
    this._entityTypeCache = new Map();
  }

  // -------------------------------------------------------------------------
  // Public connection lifecycle methods
  // -------------------------------------------------------------------------

  /**
   * Open the WebSocket connection to the Rust server.
   * Safe to call again after a disconnect — creates a fresh RustPlus client.
   */
  connect() {
    // Clear any pending reconnect timer before starting a new connection attempt
    this._clearReconnectTimer();
    this._intentionalClose = false;

    console.log(`[RustPlus] Connecting to ${this.serverIp}:${this.serverPort} (steamId: ${this.steamId})`);

    try {
      // Create a fresh RustPlus client instance
      this._rustplus = new RustPlus(
        this.serverIp,
        this.serverPort,
        this.steamId,
        this.playerToken,
        false // useFacepunchProxy — direct connection
      );

      // Wire up all internal event handlers
      this._attachRustPlusHandlers();

      // Begin the WebSocket handshake
      this._rustplus.connect();
    } catch (err) {
      console.error(`[RustPlus] Error creating client for ${this.serverIp}:${this.serverPort}:`, err);
      this.emit('error', err);
      this._scheduleReconnect();
    }
  }

  /**
   * Gracefully disconnect from the Rust server.
   * Cancels any pending reconnect timers and sets the intentional-close flag
   * so the disconnect handler does NOT trigger automatic reconnection.
   */
  disconnect() {
    console.log(`[RustPlus] Intentionally disconnecting from ${this.serverIp}:${this.serverPort}`);
    this._intentionalClose = true;
    this._clearReconnectTimer();
    this._isConnected = false;

    if (this._rustplus) {
      try {
        this._rustplus.disconnect();
      } catch (err) {
        // Suppress errors during teardown — we're closing anyway
        console.warn(`[RustPlus] Error during disconnect (${this.serverIp}:${this.serverPort}):`, err.message);
      }
      this._rustplus = null;
    }
  }

  /**
   * Returns true if the WebSocket is currently open and authenticated.
   * @returns {boolean}
   */
  isConnected() {
    return this._isConnected;
  }

  /**
   * Convenience accessor for the underlying RustPlus client.
   * Allows callers to send team messages, query entity info, etc.
   * Returns null if not connected.
   * @returns {RustPlus|null}
   */
  getClient() {
    return this._rustplus;
  }

  /**
   * Register an entity's type in the local cache.
   * Call this when you already know the type (e.g. from a pairing record or
   * getEntityInfo response) so the manager can emit the correct event.
   *
   * @param {number} entityId
   * @param {number} entityType  — one of ENTITY_TYPE.SWITCH / ALARM / STORAGE_MONITOR
   */
  registerEntityType(entityId, entityType) {
    this._entityTypeCache.set(Number(entityId), entityType);
  }

  // -------------------------------------------------------------------------
  // Internal — rustplus.js event wiring
  // -------------------------------------------------------------------------

  /**
   * Attach handlers to the current this._rustplus instance.
   * Must be called immediately after creating a new RustPlus client.
   * @private
   */
  _attachRustPlusHandlers() {
    const rp = this._rustplus;

    // -- connected ---------------------------------------------------------
    rp.on('connected', () => {
      try {
        this._onConnected();
      } catch (err) {
        console.error(`[RustPlus] Unhandled error in connected handler (${this.serverIp}:${this.serverPort}):`, err);
      }
    });

    // -- disconnected ------------------------------------------------------
    rp.on('disconnected', () => {
      try {
        this._onDisconnected();
      } catch (err) {
        console.error(`[RustPlus] Unhandled error in disconnected handler (${this.serverIp}:${this.serverPort}):`, err);
      }
    });

    // -- error -------------------------------------------------------------
    rp.on('error', (err) => {
      try {
        this._onError(err);
      } catch (handlerErr) {
        console.error(`[RustPlus] Unhandled error in error handler (${this.serverIp}:${this.serverPort}):`, handlerErr);
      }
    });

    // -- message (all broadcasts arrive here) ------------------------------
    rp.on('message', (message) => {
      try {
        this._onMessage(message);
      } catch (err) {
        console.error(`[RustPlus] Unhandled error in message handler (${this.serverIp}:${this.serverPort}):`, err);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Internal — connection lifecycle handlers
  // -------------------------------------------------------------------------

  /** @private */
  _onConnected() {
    console.log(`[RustPlus] Connected to ${this.serverIp}:${this.serverPort}`);

    this._isConnected      = true;
    this._reconnectAttempt = 0; // reset backoff on successful connection
    this._clearReconnectTimer();

    safeLog(this.steamId, 'connected', {
      server: `${this.serverIp}:${this.serverPort}`,
      time: new Date().toISOString(),
    });

    /**
     * @event RustPlusConnection#connected
     * @type {object}
     * @property {string} serverIp
     * @property {number} serverPort
     */
    this.emit('connected', {
      serverIp: this.serverIp,
      serverPort: this.serverPort,
    });
  }

  /** @private */
  _onDisconnected() {
    console.log(`[RustPlus] Disconnected from ${this.serverIp}:${this.serverPort} (intentional: ${this._intentionalClose})`);

    this._isConnected = false;

    safeLog(this.steamId, 'disconnected', {
      server: `${this.serverIp}:${this.serverPort}`,
      intentional: this._intentionalClose,
      time: new Date().toISOString(),
    });

    /**
     * @event RustPlusConnection#disconnected
     * @type {object}
     * @property {string} serverIp
     * @property {number} serverPort
     * @property {boolean} intentional
     */
    this.emit('disconnected', {
      serverIp: this.serverIp,
      serverPort: this.serverPort,
      intentional: this._intentionalClose,
    });

    // Only reconnect if this was NOT an intentional disconnect
    if (!this._intentionalClose) {
      this._scheduleReconnect();
    }
  }

  /**
   * @param {Error} err
   * @private
   */
  _onError(err) {
    console.error(`[RustPlus] WebSocket error on ${this.serverIp}:${this.serverPort}:`, err.message || err);

    /**
     * @event RustPlusConnection#error
     * @type {Error}
     */
    this.emit('error', err);

    // Note: the 'disconnected' event from rustplus.js will fire after an error,
    // which triggers _onDisconnected → _scheduleReconnect. No need to duplicate
    // reconnect logic here.
  }

  // -------------------------------------------------------------------------
  // Internal — message / broadcast handler
  // -------------------------------------------------------------------------

  /**
   * Routes incoming rustplus.js 'message' events to the appropriate typed
   * event emitter and database log.
   *
   * Broadcast shapes (from rustplus.proto AppBroadcast):
   *   message.broadcast.teamMessage  — AppNewTeamMessage { message: AppTeamMessage }
   *   message.broadcast.entityChanged — AppEntityChanged { entityId, payload }
   *
   * @param {object} message — decoded AppMessage protobuf object
   * @private
   */
  _onMessage(message) {
    if (!message || !message.broadcast) return;

    const broadcast = message.broadcast;

    // -- Team chat message -------------------------------------------------
    if (broadcast.teamMessage && broadcast.teamMessage.message) {
      this._handleTeamMessage(broadcast.teamMessage.message);
    }

    // -- Entity changed (switch, alarm, storage monitor) -------------------
    if (broadcast.entityChanged) {
      this._handleEntityChanged(broadcast.entityChanged);
    }

    // -- getEntityInfo responses also come through 'message' as AppResponse.
    // The RustPlus client routes seq-matched responses to their callbacks,
    // so they won't appear here. We don't need to handle them in this path.
  }

  /**
   * Handle an AppTeamMessage broadcast.
   *
   * @param {object} msg — AppTeamMessage { steamId, name, message, color, time }
   * @private
   */
  _handleTeamMessage(msg) {
    const payload = {
      steamId:    String(msg.steamId),
      playerName: msg.name    || '',
      message:    msg.message || '',
      time:       msg.time    || 0,
    };

    safeLog(this.steamId, 'team_chat', payload);

    /**
     * @event RustPlusConnection#teamChat
     * @type {object}
     * @property {string} steamId    — sender Steam ID
     * @property {string} playerName — sender display name
     * @property {string} message    — chat message content
     * @property {number} time       — Unix timestamp
     */
    this.emit('teamChat', payload);
  }

  /**
   * Handle an AppEntityChanged broadcast.
   * Determines entity type from the payload shape and/or the entity type cache,
   * then emits the appropriate typed event.
   *
   * Payload shape rules:
   *   - payload.items is a non-empty array OR payload.capacity is set
   *       → StorageMonitor → storageUpdated
   *   - payload.value is a boolean (and no items)
   *       → Switch and/or Alarm → switchChanged and/or alarmTriggered
   *
   * @param {object} entityChanged — AppEntityChanged { entityId, payload }
   * @private
   */
  _handleEntityChanged(entityChanged) {
    const entityId = entityChanged.entityId;
    const payload  = entityChanged.payload;

    if (!payload) return;

    // Retrieve cached type if we have it (registered via registerEntityType
    // or a prior getEntityInfo response)
    const cachedType = this._entityTypeCache.get(Number(entityId));

    const hasItems    = Array.isArray(payload.items) && payload.items.length >= 0
                        && payload.capacity != null;
    const hasValue    = payload.value !== null && payload.value !== undefined;

    // -- Storage Monitor ---------------------------------------------------
    if (cachedType === ENTITY_TYPE.STORAGE_MONITOR || hasItems) {
      this._emitStorageUpdated(entityId, payload);
      return;
    }

    // -- Switch or Alarm (value-based entities) ----------------------------
    if (hasValue) {
      if (cachedType === ENTITY_TYPE.SWITCH) {
        this._emitSwitchChanged(entityId, payload);
      } else if (cachedType === ENTITY_TYPE.ALARM) {
        this._emitAlarmTriggered(entityId, payload);
      } else {
        // Unknown type: emit switchChanged always (state change).
        // Also emit alarmTriggered when value becomes true (alarm fires).
        this._emitSwitchChanged(entityId, payload);
        if (payload.value === true) {
          this._emitAlarmTriggered(entityId, payload);
        }
      }
    }
  }

  /**
   * Emit and log a switchChanged event.
   * @param {number} entityId
   * @param {object} payload — AppEntityPayload
   * @private
   */
  _emitSwitchChanged(entityId, payload) {
    const eventPayload = {
      entityId: entityId,
      name:     null, // name is not available in entityChanged broadcasts
      value:    Boolean(payload.value),
    };

    safeLog(this.steamId, 'switch_changed', eventPayload);

    /**
     * @event RustPlusConnection#switchChanged
     * @type {object}
     * @property {number}  entityId
     * @property {null}    name     — not available in broadcast; populate from device registry if needed
     * @property {boolean} value    — true = on, false = off
     */
    this.emit('switchChanged', eventPayload);
  }

  /**
   * Emit and log an alarmTriggered event.
   * @param {number} entityId
   * @param {object} payload — AppEntityPayload
   * @private
   */
  _emitAlarmTriggered(entityId, payload) {
    const eventPayload = {
      entityId: entityId,
      name:     null, // name is not available in entityChanged broadcasts
    };

    safeLog(this.steamId, 'alarm_triggered', eventPayload);

    /**
     * @event RustPlusConnection#alarmTriggered
     * @type {object}
     * @property {number} entityId
     * @property {null}   name — not available in broadcast; populate from device registry if needed
     */
    this.emit('alarmTriggered', eventPayload);
  }

  /**
   * Emit and log a storageUpdated event.
   * @param {number} entityId
   * @param {object} payload — AppEntityPayload
   * @private
   */
  _emitStorageUpdated(entityId, payload) {
    const eventPayload = {
      entityId: entityId,
      name:     null, // name is not available in entityChanged broadcasts
      items:    payload.items    || [],
      capacity: payload.capacity || 0,
    };

    safeLog(this.steamId, 'storage_updated', eventPayload);

    /**
     * @event RustPlusConnection#storageUpdated
     * @type {object}
     * @property {number}   entityId
     * @property {null}     name     — not available in broadcast; populate from device registry if needed
     * @property {Array}    items    — array of { itemId, quantity, itemIsBlueprint }
     * @property {number}   capacity — total slot capacity of the container
     */
    this.emit('storageUpdated', eventPayload);
  }

  // -------------------------------------------------------------------------
  // Internal — reconnection logic
  // -------------------------------------------------------------------------

  /**
   * Calculate the delay (ms) for the current reconnect attempt using
   * exponential backoff: initialDelayMs * (backoffMultiplier ^ attempt), capped.
   * @private
   * @returns {number}
   */
  _getReconnectDelay() {
    const delay = this._initialDelayMs * Math.pow(this._backoffMultiplier, this._reconnectAttempt);
    return Math.min(delay, this._maxDelayMs);
  }

  /**
   * Schedule the next reconnect attempt after the calculated backoff delay.
   * Increments the attempt counter and emits a 'reconnecting' event.
   * Stops and emits 'reconnectFailed' if maxRetries is exceeded.
   * @private
   */
  _scheduleReconnect() {
    // Check if we've hit the retry ceiling
    if (this._maxRetries > 0 && this._reconnectAttempt >= this._maxRetries) {
      console.error(
        `[RustPlus] Reconnect failed: max retries (${this._maxRetries}) exceeded for ${this.serverIp}:${this.serverPort}`
      );

      safeLog(this.steamId, 'reconnect_failed', {
        server: `${this.serverIp}:${this.serverPort}`,
        attempts: this._reconnectAttempt,
        time: new Date().toISOString(),
      });

      /**
       * @event RustPlusConnection#reconnectFailed
       * @type {object}
       * @property {number} attempts — total attempts made
       */
      this.emit('reconnectFailed', { attempts: this._reconnectAttempt });
      return;
    }

    const delayMs = this._getReconnectDelay();
    this._reconnectAttempt++;

    console.log(
      `[RustPlus] Reconnecting to ${this.serverIp}:${this.serverPort} ` +
      `(attempt ${this._reconnectAttempt}, delay: ${delayMs}ms)`
    );

    safeLog(this.steamId, 'reconnecting', {
      server:   `${this.serverIp}:${this.serverPort}`,
      attempt:  this._reconnectAttempt,
      delayMs:  delayMs,
      time:     new Date().toISOString(),
    });

    /**
     * @event RustPlusConnection#reconnecting
     * @type {object}
     * @property {number} attempt  — current attempt number (1-based)
     * @property {number} delayMs  — milliseconds until the attempt fires
     */
    this.emit('reconnecting', {
      attempt: this._reconnectAttempt,
      delayMs: delayMs,
    });

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      // Double-check intentional flag in case disconnect() was called
      // while the timer was pending
      if (!this._intentionalClose) {
        this.connect();
      }
    }, delayMs);
  }

  /**
   * Cancel any pending reconnect timer.
   * @private
   */
  _clearReconnectTimer() {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

}

// ---------------------------------------------------------------------------
// Connection registry functions
// ---------------------------------------------------------------------------

/**
 * Build the canonical map key for a server.
 * @param {string} ip
 * @param {number} port
 * @returns {string}  e.g. "192.168.1.1:28082"
 */
function _connectionKey(ip, port) {
  return `${ip}:${port}`;
}

/**
 * Create a new RustPlusConnection, register it in the connections map, and
 * start the WebSocket connection. Returns the new connection instance.
 *
 * If a connection for the same ip:port already exists, it is disconnected and
 * replaced.
 *
 * @param {object} config — same shape as RustPlusConnection constructor config
 * @returns {RustPlusConnection}
 */
function createConnection(config) {
  if (!config || !config.server) {
    throw new Error('[RustPlus] createConnection: config.server is required');
  }

  const key = _connectionKey(config.server.ip, config.server.port);

  // Tear down any existing connection for the same server
  if (connections.has(key)) {
    console.log(`[RustPlus] Replacing existing connection for ${key}`);
    const existing = connections.get(key);
    existing.disconnect();
    connections.delete(key);
  }

  const connection = new RustPlusConnection(config);
  connections.set(key, connection);

  // Forward error events to prevent unhandled EventEmitter warnings.
  // Callers should attach their own 'error' listener if they need to react.
  if (connection.listenerCount('error') === 0) {
    connection.on('error', (err) => {
      console.error(`[RustPlus] Connection error (${key}):`, err.message || err);
    });
  }

  // Start the connection
  connection.connect();

  // --- ADDED: Wire game-event → team-chat broadcasters ---
  // Must be called after connect() so connection.serverIp is fully set.
  // wireBroadcasters is idempotent; safe to call even if called again later.
  wireBroadcasters(connection, db);

  // --- ADDED: Start map marker poller (cargo / heli / bradley / oil rig) ---
  startPoller(connection);

  console.log(`[RustPlus] Connection created for ${key} (steamId: ${config.steamId})`);
  return connection;
}

/**
 * Look up an active connection by server IP and port.
 *
 * @param {string} ip
 * @param {number} port
 * @returns {RustPlusConnection|undefined}
 */
function getConnection(ip, port) {
  return connections.get(_connectionKey(ip, port));
}

/**
 * Disconnect and remove a connection from the registry.
 * Does nothing if no connection exists for the given server.
 *
 * @param {string} ip
 * @param {number} port
 * @returns {boolean} true if a connection was found and removed
 */
function removeConnection(ip, port) {
  const key  = _connectionKey(ip, port);
  const conn = connections.get(key);

  if (!conn) {
    return false;
  }

  conn.disconnect();
  // --- ADDED: Stop map marker poller for this connection ---
  stopPoller(conn);
  connections.delete(key);
  console.log(`[RustPlus] Connection removed for ${key}`);
  return true;
}

/**
 * Return all active RustPlusConnection instances as an array.
 *
 * @returns {RustPlusConnection[]}
 */
function getAllConnections() {
  return Array.from(connections.values());
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  // Connection registry
  connections,
  createConnection,
  getConnection,
  removeConnection,
  getAllConnections,

  // Class export for testing / dependency injection
  RustPlusConnection,

  // Entity type constants (useful for callers calling registerEntityType)
  ENTITY_TYPE,
};
