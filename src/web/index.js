// src/web/index.js
// Express web server for MyRustLink.
// Handles Steam OpenID authentication via passport-steam, session management,
// Rust+ FCM player token pairing, and the full admin dashboard.
//
// Required environment variables:
//   SESSION_SECRET  — Strong random string used to sign session cookies
//   STEAM_API_KEY   — From https://steamcommunity.com/dev/apikey
//   BASE_URL        — Public base URL, e.g. http://localhost:3000 (no trailing slash)
//   PORT            — Listening port (default: 3000)

'use strict';

const express       = require('express');
const session       = require('express-session');
const passport      = require('passport');
const SteamStrategy = require('passport-steam').Strategy;

const { db, logEvent, getRecentEvents } = require('../db/index.js');
const { connections, createConnection, removeConnection } = require('../rustplus/index.js');
const { isFcmListening, hasFcmConfig } = require('../rustplus/fcmListener.js');

// ---------------------------------------------------------------------------
// Minimal HTML escape utility
// ---------------------------------------------------------------------------

/**
 * Escape characters that have special meaning in HTML to prevent XSS.
 * Applied to any user-supplied string rendered into an HTML response.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// HTML page wrappers
// ---------------------------------------------------------------------------

/**
 * Wrap a body fragment in a centered card layout (used for login/error pages).
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — MyRustLink</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #16213e; border-radius: 12px; padding: 2.5rem; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
    h1 { font-size: 1.8rem; margin-bottom: 0.5rem; color: #c8a96e; }
    p  { color: #aaa; margin: 1rem 0; line-height: 1.5; }
    .btn { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 2rem; border-radius: 6px; font-weight: 600; text-decoration: none; transition: opacity 0.2s; cursor: pointer; border: none; font-size: 1rem; }
    .btn-steam  { background: #1b2838; color: #c7d5e0; border: 1px solid #4a90d9; }
    .btn-steam:hover { opacity: 0.85; }
    .btn-danger { background: #7f1d1d; color: #fecaca; }
    .btn-danger:hover { opacity: 0.85; }
    .notice { background: #0f3460; border-left: 4px solid #4a90d9; padding: 1rem; border-radius: 4px; margin: 1rem 0; text-align: left; font-size: 0.9rem; }
    .notice.warn { background: #3f2000; border-left-color: #c8a96e; }
    .error { color: #f87171; margin-top: 0.75rem; font-size: 0.9rem; }
    .meta { margin-top: 2rem; font-size: 0.8rem; color: #555; }
    code { background: #0d1117; padding: 0.2rem 0.4rem; border-radius: 3px; font-size: 0.85rem; color: #7dd3fc; }
  </style>
</head>
<body>
  <div class="card">
    ${body}
  </div>
</body>
</html>`;
}

/**
 * Full-width dashboard layout with sidebar-free header/content structure.
 * Used for the dashboard and its sub-pages.
 * @param {string} title
 * @param {string} playerName  — Display name for the header greeting
 * @param {string} body
 * @param {string} [flashHtml] — Optional flash message HTML block
 * @returns {string}
 */
function dashboardPage(title, playerName, body, flashHtml = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — MyRustLink</title>
  <style>
    /* Reset */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    /* Base */
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #1a1a2e;
      color: #e0e0e0;
      min-height: 100vh;
    }

    /* Layout */
    .layout { max-width: 1200px; margin: 0 auto; padding: 0 1.5rem 3rem; }

    /* Header */
    header {
      background: #16213e;
      border-bottom: 1px solid #2a2a4e;
      padding: 0 1.5rem;
      margin-bottom: 2rem;
    }
    .header-inner {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 64px;
    }
    .header-brand {
      font-size: 1.25rem;
      font-weight: 700;
      color: #c8a96e;
      text-decoration: none;
    }
    .header-brand span { color: #7289da; }
    .header-user {
      display: flex;
      align-items: center;
      gap: 1rem;
      font-size: 0.9rem;
      color: #aaa;
    }
    .header-user strong { color: #e0e0e0; }

    /* Buttons */
    .btn {
      display: inline-block;
      padding: 0.5rem 1.25rem;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.875rem;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: opacity 0.15s, background 0.15s;
    }
    .btn-primary { background: #7289da; color: #fff; }
    .btn-primary:hover { opacity: 0.88; }
    .btn-secondary { background: #2a2a4e; color: #c7d5e0; border: 1px solid #3a3a6e; }
    .btn-secondary:hover { background: #333360; }
    .btn-danger { background: #7f1d1d; color: #fecaca; }
    .btn-danger:hover { opacity: 0.85; }
    .btn-sm { padding: 0.3rem 0.75rem; font-size: 0.8rem; }
    .btn-logout { background: #2a2a4e; color: #aaa; border: 1px solid #3a3a6e; font-size: 0.8rem; }
    .btn-logout:hover { background: #7f1d1d; color: #fecaca; border-color: #7f1d1d; }

    /* Flash messages */
    .flash {
      padding: 0.875rem 1.25rem;
      border-radius: 6px;
      margin-bottom: 1.5rem;
      font-size: 0.9rem;
      font-weight: 500;
    }
    .flash-success { background: #14532d; color: #86efac; border: 1px solid #166534; }
    .flash-error   { background: #7f1d1d; color: #fecaca; border: 1px solid #991b1b; }

    /* Panel / Card */
    .panel {
      background: #16213e;
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1.75rem;
      border: 1px solid #2a2a4e;
    }
    .panel-title {
      font-size: 1rem;
      font-weight: 700;
      color: #c8a96e;
      margin-bottom: 1.25rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid #2a2a4e;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .panel-title .count-badge {
      font-size: 0.75rem;
      background: #2a2a4e;
      color: #7289da;
      padding: 0.15rem 0.5rem;
      border-radius: 99px;
      font-weight: 600;
    }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    th {
      text-align: left;
      padding: 0.6rem 0.75rem;
      color: #7289da;
      font-weight: 600;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid #2a2a4e;
    }
    td {
      padding: 0.7rem 0.75rem;
      border-bottom: 1px solid #1e2a4a;
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(114, 137, 218, 0.05); }

    /* Status dots */
    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
    }
    .status-online  { background: #22c55e; box-shadow: 0 0 6px #22c55e88; }
    .status-offline { background: #ef4444; }
    .status-unknown { background: #6b7280; }

    /* Token status panel */
    .token-status {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .token-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.4rem 0.875rem;
      border-radius: 6px;
      font-size: 0.875rem;
      font-weight: 600;
    }
    .token-badge-ok  { background: #14532d; color: #86efac; border: 1px solid #166534; }
    .token-badge-err { background: #3f2000; color: #fcd34d; border: 1px solid #92400e; }

    /* Token form */
    .token-form { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: flex-end; }
    .token-form .field { display: flex; flex-direction: column; gap: 0.35rem; flex: 1; min-width: 240px; }
    .token-form label { font-size: 0.8rem; color: #aaa; }
    .token-form input { width: 100%; }

    /* Add server form */
    .add-form { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 1rem; }
    .add-form .field { display: flex; flex-direction: column; gap: 0.35rem; }
    .add-form .field-wide { grid-column: 1 / -1; }
    .add-form label { font-size: 0.8rem; color: #aaa; font-weight: 500; }

    /* Form inputs shared */
    input[type="text"],
    input[type="number"] {
      background: #0d1117;
      border: 1px solid #2a2a4e;
      border-radius: 5px;
      color: #e0e0e0;
      padding: 0.5rem 0.75rem;
      font-size: 0.875rem;
      width: 100%;
      transition: border-color 0.15s;
    }
    input[type="text"]:focus,
    input[type="number"]:focus {
      outline: none;
      border-color: #7289da;
    }
    input::placeholder { color: #555; }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 2.5rem 1rem;
      color: #555;
      font-size: 0.9rem;
    }
    .empty-state .empty-icon { font-size: 2rem; margin-bottom: 0.5rem; }

    /* Event log scroll */
    .event-scroll {
      max-height: 380px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: #2a2a4e transparent;
    }
    .event-scroll::-webkit-scrollbar { width: 6px; }
    .event-scroll::-webkit-scrollbar-track { background: transparent; }
    .event-scroll::-webkit-scrollbar-thumb { background: #2a2a4e; border-radius: 3px; }

    /* Mono / code */
    .mono { font-family: 'Cascadia Code', 'Fira Mono', monospace; font-size: 0.8rem; color: #7dd3fc; }

    /* Event type badge */
    .event-badge {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .event-login      { background: #1e3a5f; color: #60a5fa; }
    .event-pair       { background: #1a3a1a; color: #4ade80; }
    .event-connected  { background: #1a3a1a; color: #4ade80; }
    .event-disconnected { background: #3a1a1a; color: #f87171; }
    .event-reconnecting { background: #3a2a00; color: #fbbf24; }
    .event-reconnect_failed { background: #3a1a1a; color: #f87171; }
    .event-alarm_triggered  { background: #3a1a00; color: #fb923c; }
    .event-switch_changed   { background: #1e2a3a; color: #818cf8; }
    .event-storage_updated  { background: #1e3a2a; color: #34d399; }
    .event-team_chat        { background: #2a1e3a; color: #c084fc; }
    .event-default { background: #2a2a4e; color: #94a3b8; }

    /* Responsive adjustments */
    @media (max-width: 640px) {
      .header-inner { height: auto; padding: 0.75rem 0; flex-wrap: wrap; gap: 0.5rem; }
      .add-form { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <a class="header-brand" href="/dashboard">MyRust<span>Link</span></a>
      <div class="header-user">
        <span>Logged in as <strong>${escapeHtml(playerName)}</strong></span>
        <a class="btn btn-logout" href="/logout">Logout</a>
      </div>
    </div>
  </header>

  <div class="layout">
    ${flashHtml}
    ${body}
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Database helpers (users table)
// ---------------------------------------------------------------------------

/**
 * Insert or update a user record by steam_id.
 * Uses ON CONFLICT DO UPDATE so this is safe to call on every login.
 * @param {string} steamId
 * @param {string} playerName
 * @returns {Object} The current user row
 */
function upsertUser(steamId, playerName) {
  db.prepare(`
    INSERT INTO users (steam_id, player_name, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(steam_id) DO UPDATE SET player_name = excluded.player_name
  `).run(steamId, playerName);

  return db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId);
}

/**
 * Update the rust_plus_token column for a user.
 * @param {string} steamId
 * @param {string} playerToken
 * @returns {Object} The updated user row
 */
function updatePlayerToken(steamId, playerToken) {
  db.prepare(`
    UPDATE users SET rust_plus_token = ? WHERE steam_id = ?
  `).run(playerToken, steamId);

  return db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId);
}

// ---------------------------------------------------------------------------
// Passport strategy configuration
// ---------------------------------------------------------------------------

/**
 * Register the passport-steam OpenID 2.0 strategy.
 * This runs at startup and does NOT make any network calls.
 *
 * passport-steam handles all OpenID verification internally, including
 * checking the signed fields and validating the claimed_id against Steam's
 * OpenID endpoint — we never trust claimed_id from query params directly.
 */
function configurePassport() {
  const returnURL = `${process.env.BASE_URL || 'http://localhost:3000'}/auth/steam/callback`;
  const realm     = `${process.env.BASE_URL || 'http://localhost:3000'}/`;
  const apiKey    = process.env.STEAM_API_KEY || '';

  const steamStrategy = new SteamStrategy(
    { returnURL, realm, apiKey, profile: false },
    /**
     * Verify callback — called after Steam confirms authentication.
     * @param {string} identifier  - Verified OpenID claimed_id URL
     * @param {Object} profile     - Steam profile (may be null if API key fails)
     * @param {Function} done
     */
    function verifyUser(identifier, profile, done) {
      try {
        // Extract Steam ID from the OpenID identifier URL.
        // Format: https://steamcommunity.com/openid/id/76561199145165600
        const steamIdFromIdentifier = identifier ? identifier.replace(/^.*\//, '') : null;
        const steamId    = (profile && profile.id) || steamIdFromIdentifier;
        const playerName = (profile && profile.displayName) || '';

        if (!steamId) {
          return done(new Error('Could not determine Steam ID from login'));
        }

        const user = upsertUser(steamId, playerName);
        logEvent(steamId, 'login', `Steam login: ${playerName || steamId}`);
        return done(null, user);
      } catch (err) {
        console.error('[Auth] Error in Steam verify callback:', err);
        return done(err);
      }
    }
  );

  passport.use(steamStrategy);

  // Serialize: store only steam_id in the session cookie payload
  passport.serializeUser((user, done) => {
    done(null, user.steam_id);
  });

  // Deserialize: reload the full user row from SQLite on each request
  passport.deserializeUser((steamId, done) => {
    try {
      const user = db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId);
      done(null, user || false);
    } catch (err) {
      done(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Guard middleware — redirects unauthenticated requests to /login.
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/login');
}

/**
 * Wrap an async route handler so that any thrown error is forwarded to
 * Express's global error handler instead of causing an unhandled rejection.
 * @param {Function} fn
 * @returns {Function}
 */
const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// HTML rendering helpers for dashboard sections
// ---------------------------------------------------------------------------

/**
 * Render the Rust+ token status panel.
 * If the user has no token, shows a form to enter one via POST /api/pair.
 * If the user has a token, shows a success badge with an option to re-pair.
 * Also shows FCM listener status when the listener is active.
 * @param {Object} user - The user row from the DB
 * @returns {string} HTML string
 */
function renderTokenPanel(user) {
  const hasToken     = !!user.rust_plus_token;
  const fcmListening = isFcmListening();
  const fcmConfig    = hasFcmConfig();

  // Build FCM status block
  let fcmStatusHtml = '';
  if (fcmListening) {
    fcmStatusHtml = `
      <div style="margin-top:1.25rem; background:#0f2a1a; border-left:4px solid #22c55e; padding:0.875rem 1rem; border-radius:4px; font-size:0.875rem;">
        <div style="color:#4ade80; font-weight:600; margin-bottom:0.4rem;">&#10003; Listening for Rust+ pairings automatically</div>
        <div style="color:#aaa; line-height:1.6;">
          To pair: open Rust+ in-game &rarr; escape menu &rarr; <strong style="color:#e0e0e0;">Pair with Server</strong>.
          Your token, server IP, port, and Discord channel will all be configured automatically.
        </div>
      </div>`;
  } else if (fcmConfig) {
    fcmStatusHtml = `
      <div style="margin-top:1.25rem; background:#3f2000; border-left:4px solid #c8a96e; padding:0.875rem 1rem; border-radius:4px; font-size:0.875rem; color:#fcd34d;">
        FCM config found but listener is not active. Check server logs for details.
      </div>`;
  } else {
    fcmStatusHtml = `
      <div style="margin-top:1.25rem; background:#1a1a2e; border-left:4px solid #2a2a4e; padding:0.875rem 1rem; border-radius:4px; font-size:0.875rem; color:#888;">
        Automatic pairing not configured. Run
        <code style="background:#0d1117; padding:0.15rem 0.4rem; border-radius:3px; color:#7dd3fc;">npx @liamcottle/rustplus.js fcm-register</code>
        to enable automatic token updates.
      </div>`;
  }

  if (hasToken) {
    return `
    <div class="panel">
      <div class="panel-title">Rust+ Token Status</div>
      <div class="token-status">
        <span class="token-badge token-badge-ok">
          &#10003; Rust+ token paired
        </span>
        <span style="color:#888; font-size:0.85rem;">
          Your player token is stored. You can re-pair below if needed.
        </span>
      </div>
      ${fcmStatusHtml}
      <details style="margin-top:1.25rem;">
        <summary style="cursor:pointer; color:#7289da; font-size:0.85rem; user-select:none;">
          Re-pair token manually
        </summary>
        <form method="POST" action="/api/pair" style="margin-top:1rem;">
          <div class="token-form">
            <div class="field">
              <label for="repairToken">New Player Token</label>
              <input type="text" id="repairToken" name="playerToken"
                     placeholder="Paste your Rust+ player token"
                     autocomplete="off">
            </div>
            <button type="submit" class="btn btn-primary">Save Token</button>
          </div>
        </form>
      </details>
    </div>`;
  }

  return `
  <div class="panel">
    <div class="panel-title">Rust+ Token Status</div>
    <div style="margin-bottom:1rem;">
      <span class="token-badge token-badge-err">
        &#9888; No token paired
      </span>
      <span style="color:#888; font-size:0.85rem; margin-left:0.75rem;">
        Enter your Rust+ player token to enable server connections.
      </span>
    </div>
    ${fcmStatusHtml}
    <details style="margin-top:1.25rem;" ${fcmListening ? '' : 'open'}>
      <summary style="cursor:pointer; color:#7289da; font-size:0.85rem; user-select:none; margin-bottom:0.75rem;">
        ${fcmListening ? 'Enter token manually (fallback)' : 'Enter token manually'}
      </summary>
      <p style="color:#aaa; font-size:0.85rem; margin-bottom:1rem; line-height:1.6;">
        Obtain your token by running:
        <code style="background:#0d1117; padding:0.2rem 0.5rem; border-radius:3px; color:#7dd3fc; font-size:0.8rem;">
          npx @liamcottle/rustplus.js fcm-register
        </code>
        and following the prompts.
      </p>
      <form method="POST" action="/api/pair">
        <div class="token-form">
          <div class="field">
            <label for="playerToken">Player Token</label>
            <input type="text" id="playerToken" name="playerToken"
                   placeholder="Paste your Rust+ player token"
                   required autocomplete="off">
          </div>
          <button type="submit" class="btn btn-primary">Save Token</button>
        </div>
      </form>
    </details>
  </div>`;
}

/**
 * Render the "Add Server Pairing" form panel.
 * Disabled (informational notice only) if the user has no player token.
 * @param {Object} user - The user row from the DB
 * @returns {string} HTML string
 */
function renderAddServerPanel(user) {
  const hasFcm = !!user.rust_plus_token;

  if (!hasFcm) {
    return `
    <div class="panel">
      <div class="panel-title">Add Server Pairing</div>
      <div style="background:#3f2000; border-left:4px solid #c8a96e; padding:1rem; border-radius:4px; font-size:0.9rem; color:#fcd34d;">
        Please pair your Rust+ token first before adding server connections.
      </div>
    </div>`;
  }

  return `
  <div class="panel">
    <div class="panel-title">Add Server Pairing</div>
    <form method="POST" action="/dashboard/pairings/add">
      <div class="add-form">
        <div class="field">
          <label for="ip">Server IP *</label>
          <input type="text" id="ip" name="ip" placeholder="e.g. 192.168.1.1" required>
        </div>
        <div class="field">
          <label for="port">Server Port *</label>
          <input type="number" id="port" name="port" placeholder="28082"
                 min="1" max="65535" required>
        </div>
        <div class="field">
          <label for="guildId">Discord Guild ID *</label>
          <input type="text" id="guildId" name="guildId" placeholder="e.g. 123456789" required>
        </div>
        <div class="field">
          <label for="channelId">Discord Channel ID *</label>
          <input type="text" id="channelId" name="channelId" placeholder="e.g. 987654321" required>
        </div>
        <div class="field">
          <label for="serverName">Server Name (optional)</label>
          <input type="text" id="serverName" name="serverName" placeholder="My Rust Server">
        </div>
        <div class="field" style="display:flex; align-items:flex-end;">
          <button type="submit" class="btn btn-primary" style="width:100%;">
            Add Pairing
          </button>
        </div>
      </div>
    </form>
  </div>`;
}

/**
 * Build a connection status string for a server pairing row.
 * Checks the rustplus connections Map by "ip:port" key.
 * @param {string} ip
 * @param {number} port
 * @returns {{ label: string, dotClass: string }}
 */
function getConnectionStatus(ip, port) {
  const key  = `${ip}:${port}`;
  const conn = connections.get(key);

  if (!conn) {
    return { label: 'Offline', dotClass: 'status-offline' };
  }
  if (conn.isConnected()) {
    return { label: 'Online', dotClass: 'status-online' };
  }
  // Connection object exists but isConnected is false — likely reconnecting
  return { label: 'Reconnecting', dotClass: 'status-unknown' };
}

/**
 * Render the Connected Servers panel with a table of all server_pairings rows.
 * @returns {string} HTML string
 */
function renderServersPanel() {
  const pairings = db.prepare(
    'SELECT * FROM server_pairings ORDER BY created_at DESC'
  ).all();

  const count = pairings.length;

  if (count === 0) {
    return `
    <div class="panel">
      <div class="panel-title">
        Connected Servers
        <span class="count-badge">0</span>
      </div>
      <div class="empty-state">
        <div class="empty-icon">&#128307;</div>
        No server pairings yet. Use the form above to add your first server.
      </div>
    </div>`;
  }

  const rows = pairings.map(p => {
    const { label, dotClass } = getConnectionStatus(p.rust_server_ip, p.rust_server_port);
    const displayName = p.rust_server_name
      ? escapeHtml(p.rust_server_name)
      : `<span style="color:#555;">—</span>`;

    return `
    <tr>
      <td>${displayName}</td>
      <td class="mono">${escapeHtml(p.rust_server_ip)}:${escapeHtml(String(p.rust_server_port))}</td>
      <td class="mono">${escapeHtml(p.discord_guild_id || '—')}</td>
      <td class="mono">${escapeHtml(p.discord_channel_id || '—')}</td>
      <td>
        <span class="status-dot ${dotClass}"></span>${escapeHtml(label)}
      </td>
      <td>
        <form method="POST" action="/dashboard/pairings/delete"
              onsubmit="return confirm('Delete pairing for ${escapeHtml(p.rust_server_ip)}:${escapeHtml(String(p.rust_server_port))}?');">
          <input type="hidden" name="id" value="${escapeHtml(String(p.id))}">
          <button type="submit" class="btn btn-danger btn-sm">Delete</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  return `
  <div class="panel">
    <div class="panel-title">
      Connected Servers
      <span class="count-badge">${count}</span>
    </div>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>IP : Port</th>
            <th>Guild ID</th>
            <th>Channel ID</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  </div>`;
}

/**
 * Render the Paired Devices panel from the devices table.
 * @returns {string} HTML string
 */
function renderDevicesPanel() {
  const devices = db.prepare(
    'SELECT * FROM devices ORDER BY created_at DESC'
  ).all();

  const count = devices.length;

  if (count === 0) {
    return `
    <div class="panel">
      <div class="panel-title">
        Paired Devices
        <span class="count-badge">0</span>
      </div>
      <div class="empty-state">
        <div class="empty-icon">&#128268;</div>
        No devices paired yet. Devices are added automatically when discovered.
      </div>
    </div>`;
  }

  const rows = devices.map(d => {
    const displayName = d.name
      ? escapeHtml(d.name)
      : `<span class="mono">#${escapeHtml(String(d.entity_id))}</span>`;

    const serverStr = (d.rust_server_ip && d.rust_server_port)
      ? `<span class="mono">${escapeHtml(d.rust_server_ip)}:${escapeHtml(String(d.rust_server_port))}</span>`
      : `<span style="color:#555;">—</span>`;

    const deviceType = d.device_type
      ? escapeHtml(d.device_type)
      : `<span style="color:#555;">—</span>`;

    return `
    <tr>
      <td>${displayName}</td>
      <td>${deviceType}</td>
      <td>${serverStr}</td>
      <td>
        <form method="POST" action="/dashboard/devices/revoke"
              onsubmit="return confirm('Revoke access for this device?');">
          <input type="hidden" name="id" value="${escapeHtml(String(d.id))}">
          <button type="submit" class="btn btn-danger btn-sm">Revoke</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  return `
  <div class="panel">
    <div class="panel-title">
      Paired Devices
      <span class="count-badge">${count}</span>
    </div>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>Name / Entity ID</th>
            <th>Type</th>
            <th>Server</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  </div>`;
}

/**
 * Return a CSS class name for an event_type badge.
 * Falls back to 'event-default' for unknown types.
 * @param {string} eventType
 * @returns {string}
 */
function eventBadgeClass(eventType) {
  const known = [
    'login', 'pair', 'connected', 'disconnected', 'reconnecting',
    'reconnect_failed', 'alarm_triggered', 'switch_changed',
    'storage_updated', 'team_chat',
  ];
  return known.includes(eventType) ? `event-${eventType}` : 'event-default';
}

/**
 * Render the Recent Event Log panel using getRecentEvents(20).
 * @returns {string} HTML string
 */
function renderEventLogPanel() {
  const events = getRecentEvents(20);
  const count  = events.length;

  if (count === 0) {
    return `
    <div class="panel">
      <div class="panel-title">Recent Event Log</div>
      <div class="empty-state">
        <div class="empty-icon">&#128203;</div>
        No events logged yet.
      </div>
    </div>`;
  }

  const rows = events.map(ev => {
    // timestamp may be a string like "2024-01-01 00:00:00" from SQLite
    const ts = ev.timestamp
      ? new Date(ev.timestamp).toLocaleString(undefined, {
          month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        })
      : '—';

    // Truncate long messages for readability
    let msg = String(ev.message || '');
    if (msg.length > 200) {
      msg = msg.slice(0, 200) + '…';
    }

    const badgeClass = eventBadgeClass(ev.event_type || '');

    return `
    <tr>
      <td style="white-space:nowrap; color:#888; font-size:0.8rem;">${escapeHtml(ts)}</td>
      <td>
        <span class="event-badge ${escapeHtml(badgeClass)}">
          ${escapeHtml(ev.event_type || 'unknown')}
        </span>
      </td>
      <td style="font-size:0.82rem; color:#ccc; word-break:break-all;">${escapeHtml(msg)}</td>
    </tr>`;
  }).join('');

  return `
  <div class="panel">
    <div class="panel-title">
      Recent Event Log
      <span class="count-badge">last ${count}</span>
    </div>
    <div class="event-scroll">
      <table>
        <thead>
          <tr>
            <th style="white-space:nowrap;">Time</th>
            <th>Type</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  </div>`;
}

/**
 * Build the full dashboard HTML body for GET /dashboard.
 * @param {Object} user       - Authenticated user row
 * @param {string} flashHtml  - Pre-built flash message HTML (may be empty)
 * @returns {string}
 */
function buildDashboardBody(user) {
  return [
    renderTokenPanel(user),
    renderAddServerPanel(user),
    renderServersPanel(),
    renderDevicesPanel(),
    renderEventLogPanel(),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/**
 * Mount all application routes onto the provided Express app.
 * @param {import('express').Application} app
 */
function mountRoutes(app) {
  // -- Root ------------------------------------------------------------------
  app.get('/', (req, res) => {
    if (req.isAuthenticated()) {
      return res.redirect('/dashboard');
    }
    res.redirect('/login');
  });

  // -- Health ----------------------------------------------------------------
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // -- Login page ------------------------------------------------------------
  app.get('/login', (req, res) => {
    const errorParam = req.query.error;
    let errorHtml = '';
    if (errorParam === 'verification_failed') {
      errorHtml = '<p class="error">Steam verification failed. Please try again.</p>';
    } else if (errorParam === 'auth_failed') {
      errorHtml = '<p class="error">Authentication was not completed. Please try again.</p>';
    } else if (errorParam) {
      errorHtml = '<p class="error">An error occurred. Please try again.</p>';
    }

    res.send(page('Login', `
      <h1>MyRustLink</h1>
      <p>Connect your Steam account to manage your Rust server notifications.</p>
      ${errorHtml}
      <a class="btn btn-steam" href="/auth/steam">Login with Steam</a>
      <p class="meta">You will be redirected to Steam to authenticate securely.</p>
    `));
  });

  // -- Steam OpenID initiation -----------------------------------------------
  // passport.authenticate('steam') builds the OpenID redirect URL and sends
  // the browser to Steam — no network call happens on the server here.
  app.get('/auth/steam', passport.authenticate('steam'));

  // -- Steam OpenID callback -------------------------------------------------
  // Steam redirects back here after the user authenticates (or cancels).
  // passport.authenticate verifies the OpenID response server-side before
  // calling our verify callback — claimed_id is never trusted from params alone.
  app.get(
    '/auth/steam/callback',
    (req, res, next) => {
      passport.authenticate('steam', (err, user) => {
        if (err) {
          console.error('[Auth] Steam callback error:', err.message || err);
          return res.redirect('/login?error=auth_failed');
        }
        if (!user) {
          return res.redirect('/login?error=auth_failed');
        }
        req.logIn(user, (loginErr) => {
          if (loginErr) {
            console.error('[Auth] Session login error:', loginErr);
            return res.redirect('/login?error=auth_failed');
          }
          return res.redirect('/dashboard');
        });
      })(req, res, next);
    }
  );

  // -- Dashboard (GET) -------------------------------------------------------
  app.get('/dashboard', requireAuth, (req, res) => {
    const user       = req.user;
    const playerName = user.player_name || user.steam_id;

    // Read one-time flash messages set by redirect routes
    let flashHtml = '';
    if (req.query.success === '1') {
      flashHtml = '<div class="flash flash-success">Server pairing added successfully.</div>';
    } else if (req.query.deleted === '1') {
      flashHtml = '<div class="flash flash-success">Server pairing deleted.</div>';
    } else if (req.query.revoked === '1') {
      flashHtml = '<div class="flash flash-success">Device access revoked.</div>';
    } else if (req.query.error === 'invalid_ip') {
      flashHtml = '<div class="flash flash-error">Invalid IP address. Please enter a non-empty server IP.</div>';
    } else if (req.query.error === 'invalid_port') {
      flashHtml = '<div class="flash flash-error">Invalid port. Port must be a number between 1 and 65535.</div>';
    } else if (req.query.error === 'db') {
      flashHtml = '<div class="flash flash-error">A database error occurred. Please try again.</div>';
    } else if (req.query.error === 'pair_first') {
      flashHtml = '<div class="flash flash-error">Please pair your Rust+ token before adding a server.</div>';
    } else if (req.query.paired === '1') {
      flashHtml = '<div class="flash flash-success">Rust+ token saved successfully.</div>';
    }

    try {
      const body = buildDashboardBody(user);
      res.send(dashboardPage('Dashboard', playerName, body, flashHtml));
    } catch (err) {
      console.error('[Dashboard] Error rendering dashboard:', err);
      res.status(500).send(page('Error', `
        <h1>Dashboard error</h1>
        <p>An error occurred while loading the dashboard. Please try again.</p>
        <a class="btn btn-steam" href="/dashboard">Retry</a>
      `));
    }
  });

  // -- Logout ----------------------------------------------------------------
  app.get('/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) { return next(err); }
      req.session.destroy(() => {
        res.redirect('/login');
      });
    });
  });

  // -- API: pairing status ---------------------------------------------------
  app.get('/api/pairing-status', requireAuth, (req, res) => {
    const user = req.user;
    res.json({
      hasFcmToken: !!user.rust_plus_token,
      steamId: user.steam_id,
    });
  });

  // -- API: FCM listener status ----------------------------------------------
  // Returns whether rustplus.config.json exists and whether the FCM listener
  // is currently active. Useful for the dashboard and external monitoring.
  app.get('/api/fcm-status', requireAuth, (req, res) => {
    res.json({
      hasConfig: hasFcmConfig(),
      listening: isFcmListening(),
    });
  });

  // -- API: pair -------------------------------------------------------------
  //
  // Accepts a playerToken submitted via the dashboard form or programmatically.
  // After storing the token, redirects to /dashboard (form POST) or returns
  // JSON (API call) based on the Accept header.
  //
  app.post('/api/pair', requireAuth, asyncHandler(async (req, res) => {
    const { playerToken } = req.body;

    if (!playerToken || typeof playerToken !== 'string' || playerToken.trim() === '') {
      // If it looks like a browser form submission, redirect with an error
      const wantJson = (req.get('Accept') || '').includes('application/json');
      if (wantJson) {
        return res.status(400).json({ success: false, error: 'playerToken is required' });
      }
      return res.redirect('/dashboard');
    }

    const trimmed = playerToken.trim();

    updatePlayerToken(req.user.steam_id, trimmed);
    logEvent(req.user.steam_id, 'pair', 'Rust+ player token stored');

    // Refresh the user object on the session so subsequent reads are current
    req.user.rust_plus_token = trimmed;

    const wantJson = (req.get('Accept') || '').includes('application/json');
    if (wantJson) {
      return res.json({ success: true });
    }
    return res.redirect('/dashboard?paired=1');
  }));

  // -- Dashboard: add server pairing -----------------------------------------
  // Validates input, inserts into server_pairings, triggers a RustPlus
  // connection attempt, then redirects back with a success indicator.
  app.post('/dashboard/pairings/add', requireAuth, asyncHandler(async (req, res) => {
    const user = req.user;

    // Require a player token before connecting to any server
    if (!user.rust_plus_token) {
      return res.redirect('/dashboard?error=pair_first');
    }

    const { ip, port: portRaw, guildId, channelId, serverName } = req.body;

    // Validate IP
    if (!ip || typeof ip !== 'string' || ip.trim() === '') {
      return res.redirect('/dashboard?error=invalid_ip');
    }

    // Validate port
    const portNum = parseInt(portRaw, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return res.redirect('/dashboard?error=invalid_port');
    }

    const cleanIp         = ip.trim();
    const cleanGuildId    = (guildId    || '').trim();
    const cleanChannelId  = (channelId  || '').trim();
    const cleanServerName = (serverName || '').trim() || null;

    try {
      // Insert the pairing record
      db.prepare(`
        INSERT INTO server_pairings
          (user_steam_id, rust_server_ip, rust_server_port, rust_server_name, discord_guild_id, discord_channel_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(user.steam_id, cleanIp, portNum, cleanServerName, cleanGuildId, cleanChannelId);

      logEvent(user.steam_id, 'pairing_added',
        `Server pairing added: ${cleanIp}:${portNum} guild=${cleanGuildId}`);
    } catch (dbErr) {
      console.error('[Dashboard] DB error adding pairing:', dbErr);
      return res.redirect('/dashboard?error=db');
    }

    // Kick off the RustPlus WebSocket connection asynchronously.
    // We wrap in try/catch because createConnection() may throw if config is bad.
    try {
      const newConn = createConnection({
        steamId:     user.steam_id,
        playerToken: Number(user.rust_plus_token), // rustplus.js expects a number
        server: {
          ip:   cleanIp,
          port: portNum,
        },
        guildId:   cleanGuildId   || undefined,
        channelId: cleanChannelId || undefined,
      });

      // Wire Discord event-forwarding for this new connection.
      // Late-require avoids a load-order circular dependency since bot/index.js
      // also requires web/index.js is fully loaded first when it requires db.
      if (newConn && !newConn._discordEventsWired) {
        try {
          const { wireConnectionEvents } = require('../bot/index.js');
          newConn._discordEventsWired = true;
          wireConnectionEvents(newConn);
        } catch (wireErr) {
          console.error('[Dashboard] Failed to wire Discord events for new connection:', wireErr.message);
        }
      }
    } catch (connErr) {
      // Log but do not fail the request — the pairing row was already saved
      console.error('[Dashboard] Error creating connection after pairing add:', connErr);
    }

    return res.redirect('/dashboard?success=1');
  }));

  // -- Dashboard: delete server pairing --------------------------------------
  // Disconnects the WebSocket connection (if any) and removes the DB row.
  app.post('/dashboard/pairings/delete', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.body;

    if (!id) {
      return res.redirect('/dashboard');
    }

    const idNum = parseInt(id, 10);
    if (isNaN(idNum)) {
      return res.redirect('/dashboard');
    }

    // Look up the pairing so we can disconnect the right server
    const pairing = db.prepare(
      'SELECT * FROM server_pairings WHERE id = ?'
    ).get(idNum);

    if (pairing) {
      // Disconnect the WebSocket if it exists (removeConnection is safe to call
      // even if no connection is active — it returns false without throwing)
      try {
        removeConnection(pairing.rust_server_ip, pairing.rust_server_port);
      } catch (connErr) {
        console.error('[Dashboard] Error removing connection during pairing delete:', connErr);
      }

      // Delete from DB
      try {
        db.prepare('DELETE FROM server_pairings WHERE id = ?').run(idNum);
        logEvent(req.user.steam_id, 'pairing_deleted',
          `Pairing deleted: ${pairing.rust_server_ip}:${pairing.rust_server_port}`);
      } catch (dbErr) {
        console.error('[Dashboard] DB error deleting pairing:', dbErr);
        return res.redirect('/dashboard?error=db');
      }
    }

    return res.redirect('/dashboard?deleted=1');
  }));

  // -- Dashboard: revoke device access ----------------------------------------
  // Removes the device row from the devices table.
  // Note: there is no active "device connection" to tear down (devices are
  // entities discovered through the Rust+ WebSocket, not separate connections).
  app.post('/dashboard/devices/revoke', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.body;

    if (!id) {
      return res.redirect('/dashboard');
    }

    const idNum = parseInt(id, 10);
    if (isNaN(idNum)) {
      return res.redirect('/dashboard');
    }

    try {
      const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(idNum);
      db.prepare('DELETE FROM devices WHERE id = ?').run(idNum);

      if (device) {
        logEvent(req.user.steam_id, 'device_revoked',
          `Device revoked: ${device.name || device.entity_id} (id=${idNum})`);
      }
    } catch (dbErr) {
      console.error('[Dashboard] DB error revoking device:', dbErr);
      return res.redirect('/dashboard?error=db');
    }

    return res.redirect('/dashboard?revoked=1');
  }));

  // -- API: connections (JSON) -----------------------------------------------
  // Returns an array of all registered connections with their live status.
  app.get('/api/connections', requireAuth, (req, res) => {
    const result = [];
    for (const [key, conn] of connections.entries()) {
      result.push({
        key,
        serverIp:    conn.serverIp,
        serverPort:  conn.serverPort,
        isConnected: conn.isConnected(),
        guildId:     conn.guildId   || null,
        channelId:   conn.channelId || null,
      });
    }
    res.json(result);
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Create and start the Express application.
 * Registers session middleware, configures passport, mounts all routes,
 * and begins listening on the configured port.
 * @returns {Promise<import('http').Server>}
 */
function startWebServer() {
  return new Promise((resolve, reject) => {
    const app  = express();
    const port = parseInt(process.env.PORT || '3000', 10);
    const sessionSecret = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

    if (!process.env.SESSION_SECRET) {
      console.warn('[Web] WARNING: SESSION_SECRET not set — using insecure default. Set it in .env before deploying.');
    }
    if (!process.env.STEAM_API_KEY) {
      console.warn('[Web] WARNING: STEAM_API_KEY not set — Steam profile names will be empty.');
    }

    // -- Body parsers --------------------------------------------------------
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    // -- Session middleware --------------------------------------------------
    // In-memory store (default) is fine for development.
    // Replace with a persistent store (e.g. better-sqlite3-session-store)
    // before deploying to production so sessions survive restarts.
    app.use(session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,                                     // Prevent JS access to cookie
        secure: process.env.NODE_ENV === 'production',      // HTTPS only in production
        sameSite: 'lax',                                    // CSRF mitigation
        maxAge: 7 * 24 * 60 * 60 * 1000,                   // 7 days
      },
    }));

    // -- Passport ------------------------------------------------------------
    configurePassport();
    app.use(passport.initialize());
    app.use(passport.session());

    // -- Routes --------------------------------------------------------------
    mountRoutes(app);

    // -- Global error handler ------------------------------------------------
    // Must be registered AFTER all routes (4-argument signature).
    // Logs the full error server-side; sends a safe generic message to the client.
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      console.error('[Web] Unhandled error:', err);

      if (res.headersSent) {
        return next(err);
      }

      const isApiRoute = req.path.startsWith('/api/');
      if (isApiRoute) {
        return res.status(500).json({ error: 'Internal server error' });
      }

      res.status(500).send(page('Error', `
        <h1>Something went wrong</h1>
        <p>An unexpected error occurred. Please try again or return to the login page.</p>
        <a class="btn btn-steam" href="/login">Back to Login</a>
      `));
    });

    // -- Listen --------------------------------------------------------------
    const server = app.listen(port, () => {
      console.log(`[Web] Web server started on port ${port}`);
      console.log(`[Web] Visit ${process.env.BASE_URL || `http://localhost:${port}`}`);
      resolve(server);
    });

    server.on('error', (err) => {
      console.error('[Web] Server failed to start:', err);
      reject(err);
    });
  });
}

module.exports = { startWebServer };
