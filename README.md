# MyRustLink

MyRustLink is a self-hosted bridge between your Rust game server and a Discord server. It connects to the Rust+ companion app protocol over WebSocket, forwards in-game team chat messages to a Discord channel, posts alerts when smart alarms trigger or storage monitors fill up, and lets you control smart switches from Discord slash commands. A Steam-authenticated web dashboard lets you manage server pairings, save your Rust+ player token, and monitor the event log — no config files to edit after the initial setup.

---

## Prerequisites

- **Node.js 18 or later** — see installation instructions below
- **A Rust game server** with the Rust+ companion app feature enabled (Rust Experimental servers on Facepunch-compatible hosts)
- **A Steam account** with Rust installed and the Rust+ phone app linked in-game
- **A Discord account** with administrator access to a Discord server you control
- **A Steam API key** — required for Steam OpenID login to work correctly

---

## Installing Node.js

### Option A — Homebrew (macOS, recommended)

If you do not have Homebrew installed, install it first:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Then install Node.js:

```bash
brew install node
```

### Option B — Direct Download

Go to [https://nodejs.org](https://nodejs.org) and download the **LTS** release for your operating system. Run the installer and follow the prompts.

### Verify Installation

```bash
node --version   # should print v18.x.x or higher
npm --version    # should print 9.x.x or higher
```

---

## Installation

```bash
git clone https://github.com/your-username/myrustlink.git
cd myrustlink
npm install
cp .env.example .env
```

Then open `.env` in a text editor and fill in your credentials as described in the **Configuration** section below.

---

## Getting a Steam API Key

The Steam API key is used by the web panel to look up your Steam display name after you log in via Steam OpenID.

1. Go to [https://steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) and sign in with your Steam account.
2. In the **Domain Name** field, enter `localhost` (for local development) or your server's domain name if you are hosting publicly.
3. Agree to the Terms of Service and click **Register**.
4. Copy the key that appears and paste it as the value of `STEAM_API_KEY` in your `.env` file.

---

## Creating a Discord Bot

### 1. Create the Application

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications) and click **New Application**.
2. Give it a name (e.g. "MyRustLink") and click **Create**.
3. Copy the **Application ID** shown on the General Information page — this is your `DISCORD_CLIENT_ID`.

### 2. Create the Bot Account

1. In the left sidebar, click **Bot**.
2. Click **Add Bot**, then confirm.
3. Under the bot's username, click **Reset Token** and copy the token that appears. Paste it as `DISCORD_BOT_TOKEN` in `.env`. Keep this secret — anyone with this token can control your bot.

### 3. Enable Required Gateway Intents

On the **Bot** page, scroll down to **Privileged Gateway Intents** and enable:

| Intent | Why it is needed |
|--------|-----------------|
| **Server Members Intent** | Allows the bot to read member display names in slash command responses |
| **Message Content Intent** | Required for the bot to read message content in text channels |

Click **Save Changes**.

### 4. Invite the Bot to Your Server

1. In the left sidebar, click **OAuth2**, then **URL Generator**.
2. Under **Scopes**, check `bot` and `applications.commands`.
3. Under **Bot Permissions**, check:
   - Send Messages
   - Embed Links
   - Mention Everyone
4. Copy the generated URL at the bottom, open it in your browser, select your server, and click **Authorize**.

---

## Pairing Rust+

To connect to your Rust server, MyRustLink needs your Rust+ **player token** — a long integer that acts as your authentication credential for the Rust+ companion app protocol.

### Step 1 — Link Rust+ In-Game

1. Launch Rust on your PC.
2. Open the in-game Rust+ menu (press `F1` or look for the companion app icon).
3. Follow the prompts to pair the Rust+ phone app with your Steam account.

### Step 2 — Get Your Player Token

Run the following command in your terminal (in the project directory or anywhere with Node.js installed):

```bash
npx @liamcottle/rustplus.js fcm-register
```

Follow the interactive prompts. You will be asked to log in with Steam and grant permissions. At the end, the tool will print your **Player Token** — a large integer. Copy it.

### Step 3 — Save the Token in the Dashboard

1. Start MyRustLink (`node index.js`).
2. Open [http://localhost:3000](http://localhost:3000) in your browser.
3. Click **Login with Steam** and authenticate.
4. On the dashboard, paste your player token into the **Rust+ Token Status** panel and click **Save Token**.

---

## Configuration (.env)

Copy `.env.example` to `.env` and fill in each variable:

| Variable | Description | Example |
|----------|-------------|---------|
| `DISCORD_BOT_TOKEN` | Your Discord bot token from the Bot page | `MTExMjM0NTY3...` |
| `DISCORD_CLIENT_ID` | Your Discord application ID (also called Client ID) | `1112345678901234567` |
| `DISCORD_GUILD_ID` | (Optional) Your Discord server ID. If set, slash commands are registered only to this server and update instantly. Leave blank for global registration (takes up to 1 hour to propagate). | `9876543210987654321` |
| `STEAM_API_KEY` | Your Steam Web API key from steamcommunity.com/dev/apikey | `A1B2C3D4E5F6...` |
| `SESSION_SECRET` | A long random string used to sign session cookies. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | `f3a1b9c2...` |
| `BASE_URL` | The public URL of this app — used for Steam OpenID return URL and links | `http://localhost:3000` |
| `PORT` | The port the web server listens on | `3000` |

---

## Running the App

```bash
node index.js
```

Successful startup looks like this:

```
[DB] Database initialised at /path/to/data/myrustlink.db
[App] MyRustLink is starting...
[Web] Web server started on port 3000
[Web] Visit http://localhost:3000
[Bot] Connecting to Discord gateway...
[Bot] Logged in as MyRustLink#1234
[Bot] Serving 1 guild(s)
[Bot] Registering 7 guild-scoped commands (guild: 9876543210987654321)...
[Bot] Guild-scoped slash commands registered.
[Bot] Ready.
[App] Found 2 server pairing(s) in database — opening connections...
[RustPlus] Connecting to 192.168.1.100:28082 (steamId: 76561198000000000)
[RustPlus] Connected to 192.168.1.100:28082
[App] Loaded 2 Rust+ connection(s) from database.
[App] MyRustLink started successfully.
[App] Web panel: http://localhost:3000
```

Open [http://localhost:3000](http://localhost:3000) in your browser to access the web dashboard.

For development with auto-restart on file changes, install nodemon and use:

```bash
npm run dev
```

---

## Discord Slash Commands

| Command | Options | Description |
|---------|---------|-------------|
| `/setup` | `ip` (required), `port` (required), `channel` (required) | Link a Rust server to a Discord channel. Records the server pairing and opens a Rust+ connection. |
| `/devices` | — | List all smart devices paired with this guild's Rust server. |
| `/switch` | `name` (required), `state` (on/off, required) | Toggle a smart switch on or off. Also sends a notification to Rust team chat. |
| `/alarm` | `name` (required) | Check the current trigger state of a smart alarm. |
| `/storage` | `name` (required) | View the current contents of a storage monitor. |
| `/status` | — | Show all active Rust+ WebSocket connections and their online/offline state. |
| `/say` | `message` (required) | Send a message to Rust team chat, prefixed with your Discord display name. |

Slash commands are registered globally by default. Set `DISCORD_GUILD_ID` in `.env` for instant guild-scoped registration during development.

---

## How It Works

```
Steam Login (browser)
        |
        v
  Web Dashboard (Express + passport-steam)
        |
        |--- saves player token to SQLite (users.rust_plus_token)
        |--- saves server pairing to SQLite (server_pairings)
        |--- calls createConnection() → opens RustPlusConnection WebSocket
        |
   RustPlusConnection (per server, EventEmitter)
        |
        |--- emits: teamChat, alarmTriggered, switchChanged, storageUpdated
        |
        |--- broadcaster.js: sends in-game team chat alerts (alarm fired, storage full)
        |--- wireConnectionEvents(): forwards events as Discord embeds to the
             configured Discord text channel
        |
  Discord Bot (discord.js v14)
        |
        |--- slash commands interact with RustPlusConnection via getConnection()
        |--- /switch calls setEntityValue() on the active connection
        |--- /alarm and /storage call getEntityInfo() on the active connection
        |--- /say calls sendTeamMessage() on the active connection
```

On startup, MyRustLink loads all saved server pairings from SQLite and reconnects each one automatically. Connections use exponential-backoff reconnection (up to 10 retries, capped at 60 seconds between attempts).

---

## Troubleshooting

### Bot is not responding to slash commands

- Verify `DISCORD_BOT_TOKEN` and `DISCORD_CLIENT_ID` are correct in `.env`.
- Check the startup log for `[Bot] Logged in as ...` — if that line is missing, the token is wrong or the gateway is unreachable.
- If commands are registered globally (no `DISCORD_GUILD_ID`), wait up to 1 hour for Discord to propagate them. For instant updates, set `DISCORD_GUILD_ID` to your server's ID.
- Make sure the bot has been invited to your server with the `bot` and `applications.commands` scopes.

### Steam login redirects to an error page

- Verify `STEAM_API_KEY` is a valid key from [https://steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey).
- Verify `BASE_URL` matches the URL you are accessing the app from exactly (including port, no trailing slash).
- If you changed `PORT`, update `BASE_URL` to match.

### Rust+ connection stays offline

- Confirm your player token is correct. You can re-run `npx @liamcottle/rustplus.js fcm-register` to get a fresh token.
- Verify the server IP and port are reachable from your machine (`telnet SERVER_IP APP_PORT`). The app port is typically `28082`, not the game port.
- Check the event log on the dashboard for `reconnect_failed` entries.
- The Rust server must have the Rust+ companion app feature enabled.

### Port 3000 is already in use

Run the following to free the port, then restart:

```bash
npx kill-port 3000
node index.js
```

Or change the port by setting `PORT=3001` (and updating `BASE_URL` accordingly) in `.env`.

### Session resets after restart

By default, sessions are stored in memory and are lost on restart. This is fine for development. To persist sessions across restarts, replace the default `express-session` store with a file-based or database-backed store such as `better-sqlite3-session-store`.

### WARNING: SESSION_SECRET not set

Generate a strong secret and add it to `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
