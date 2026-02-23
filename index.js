// index.js
// MyRustLink — application entry point.
//
// Startup order:
//   1. Load environment variables (dotenv — must be first)
//   2. Initialise the database (schema migrations run on require)
//   3. Start the Express web server
//   4. Start the Discord bot (gateway login + slash command registration)
//   5. Load all persisted server_pairings and open Rust+ WebSocket connections
//   6. Wire Discord event-forwarding listeners onto each loaded connection
//
// Graceful shutdown on SIGINT / SIGTERM:
//   - Disconnect all Rust+ WebSocket connections
//   - Close the HTTP server
//   - Exit cleanly

'use strict';

// ---------------------------------------------------------------------------
// Step 1: Environment variables — MUST be loaded before any other require
// ---------------------------------------------------------------------------
require('dotenv/config');

// ---------------------------------------------------------------------------
// Process-level safety nets — register before any async work begins
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  console.error('[App] Unhandled promise rejection:', reason);
  // Do NOT exit here — let the individual operation fail gracefully
});

process.on('uncaughtException', (err) => {
  console.error('[App] Uncaught exception:', err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Module imports (after dotenv is loaded)
// ---------------------------------------------------------------------------
const { db }                        = require('./src/db/index.js');
const { startWebServer }            = require('./src/web/index.js');
const { startBot, client, wireConnectionEvents } = require('./src/bot/index.js');
const { createConnection, getAllConnections, removeConnection } = require('./src/rustplus/index.js');

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap() {
  console.log('[App] MyRustLink is starting...');

  // -------------------------------------------------------------------------
  // Step 2: Database — initialised synchronously on require above.
  // The [DB] log line is printed inside src/db/index.js on import.
  // Nothing async needed here; the db object is ready to use.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Step 3: Start the Express web server
  // -------------------------------------------------------------------------
  let httpServer;
  try {
    httpServer = await startWebServer();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[App] Port ${process.env.PORT || 3000} is already in use. ` +
        'Stop the process using that port or set a different PORT in .env.'
      );
    } else {
      console.error('[App] Failed to start web server:', err);
    }
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Step 4: Start the Discord bot (non-fatal if token is missing/invalid)
  // -------------------------------------------------------------------------
  try {
    await startBot();
  } catch (err) {
    console.error('[App] Failed to start Discord bot:', err);
    // Non-fatal — web panel and Rust+ connections still work without Discord
  }

  // -------------------------------------------------------------------------
  // Step 5: Load all server_pairings from the database and open connections
  // -------------------------------------------------------------------------
  let connectionCount = 0;

  try {
    const pairings = db.prepare('SELECT * FROM server_pairings ORDER BY created_at ASC').all();

    console.log(`[App] Found ${pairings.length} server pairing(s) in database — opening connections...`);

    for (const pairing of pairings) {
      // Each pairing requires a player token from the linked user record.
      // Tokens are stored on the users table under rust_plus_token.
      let playerToken = null;

      try {
        const userRow = db.prepare('SELECT rust_plus_token FROM users WHERE steam_id = ?')
          .get(pairing.user_steam_id);

        if (!userRow || !userRow.rust_plus_token) {
          console.warn(
            `[App] Skipping pairing id=${pairing.id} (${pairing.rust_server_ip}:${pairing.rust_server_port}) ` +
            `— no rust_plus_token for steam_id=${pairing.user_steam_id}`
          );
          continue;
        }

        playerToken = Number(userRow.rust_plus_token);
      } catch (userLookupErr) {
        console.error(
          `[App] DB error looking up token for pairing id=${pairing.id} ` +
          `(steam_id=${pairing.user_steam_id}):`,
          userLookupErr.message
        );
        continue;
      }

      // Open the connection — createConnection registers it in the global Map
      // and calls .connect() immediately. Failures are per-connection and
      // non-fatal: one bad server must not block others from connecting.
      try {
        console.log(
          `[App] Opening Rust+ connection for ${pairing.rust_server_ip}:${pairing.rust_server_port} ` +
          `(pairing id=${pairing.id}, steam_id=${pairing.user_steam_id})`
        );

        createConnection({
          steamId:     pairing.user_steam_id,
          playerToken: playerToken,
          server: {
            ip:   pairing.rust_server_ip,
            port: pairing.rust_server_port,
          },
          guildId:   pairing.discord_guild_id   || undefined,
          channelId: pairing.discord_channel_id || undefined,
        });

        connectionCount++;
      } catch (connErr) {
        console.error(
          `[App] Failed to create connection for pairing id=${pairing.id} ` +
          `(${pairing.rust_server_ip}:${pairing.rust_server_port}):`,
          connErr.message
        );
        // Continue to the next pairing
      }
    }

    console.log(`[App] Loaded ${connectionCount} Rust+ connection(s) from database.`);
  } catch (err) {
    console.error('[App] Error loading server pairings from database:', err);
    // Non-fatal — app continues without pre-loaded connections
  }

  // -------------------------------------------------------------------------
  // Step 6: Wire Discord event-forwarding onto every loaded connection.
  //
  // The bot's internal 'ready' handler already calls wireConnectionEvents for
  // any connections that existed before the bot logged in. However, because
  // the connections are created in Step 5 (after startBot() returns), the
  // 'ready' handler runs before Step 5 finishes. We therefore call
  // wireConnectionEvents here explicitly for all connections so that Discord
  // forwarding is guaranteed regardless of timing.
  //
  // wireConnectionEvents is safe to call more than once on the same connection
  // instance because EventEmitter accumulates listeners, but the channel-lookup
  // and send logic is stateless — duplicate listeners would double-post.
  // We guard against this with the _discordEventsWired flag below.
  // -------------------------------------------------------------------------
  try {
    for (const conn of getAllConnections()) {
      // Guard: skip if we already wired this connection (e.g. the bot 'ready'
      // handler ran after connections were available in some timing scenario).
      if (conn._discordEventsWired) continue;
      conn._discordEventsWired = true;

      wireConnectionEvents(conn);
    }
  } catch (wireErr) {
    console.error('[App] Error wiring Discord event forwarding:', wireErr);
  }

  console.log('[App] MyRustLink started successfully.');
  console.log(`[App] Web panel: ${process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`}`);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  console.log(`\n[App] Received ${signal} — shutting down gracefully...`);

  // Disconnect all active Rust+ WebSocket connections
  const activeConnections = getAllConnections();
  if (activeConnections.length > 0) {
    console.log(`[App] Disconnecting ${activeConnections.length} Rust+ connection(s)...`);
    for (const conn of activeConnections) {
      try {
        conn.disconnect();
      } catch (err) {
        console.error(
          `[App] Error disconnecting ${conn.serverIp}:${conn.serverPort} during shutdown:`,
          err.message
        );
      }
    }
  }

  // Disconnect the Discord bot gateway
  if (client && client.isReady && client.isReady()) {
    try {
      client.destroy();
      console.log('[App] Discord client destroyed.');
    } catch (err) {
      console.error('[App] Error destroying Discord client during shutdown:', err.message);
    }
  }

  console.log('[App] Shutdown complete.');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
bootstrap();
