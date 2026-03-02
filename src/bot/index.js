// src/bot/index.js
// MyRustLink — Discord bot module.
//
// Exports startBot() which creates a discord.js v14 Client, registers all
// slash commands via the Discord REST API, wires up interaction handlers, and
// forwards Rust+ connection-manager events to the appropriate Discord channels.
//
// Environment variables consumed:
//   DISCORD_BOT_TOKEN    — bot token for gateway login
//   DISCORD_CLIENT_ID    — application / client ID for REST command registration
//
// Rust+ connection manager API (from src/rustplus/index.js):
//   createConnection(config)  → RustPlusConnection
//   getConnection(ip, port)   → RustPlusConnection | undefined
//   getAllConnections()        → RustPlusConnection[]
//
// RustPlusConnection events:
//   'teamChat'        { steamId, playerName, message, time }
//   'alarmTriggered'  { entityId, name }
//   'switchChanged'   { entityId, name, value }
//   'storageUpdated'  { entityId, name, items, capacity }
//   'connected'       { serverIp, serverPort }
//   'disconnected'    { serverIp, serverPort, intentional }

'use strict';

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
} = require('discord.js');

const { db } = require('../db/index.js');
const {
  createConnection,
  getAllConnections,
  getConnection,
} = require('../rustplus/index.js');

// --- ADDED: Map marker poller — timer state queries ---
const {
  getTimerSummary,
  getTimerState,
  getSingleTimerMessage,
  getLiveCrateStatus,
} = require('../rustplus/mapPoller.js');

// --- ADDED: BattleMetrics integration ---
const bmApi     = require('../battlemetrics/api.js');
const bmTracker = require('../battlemetrics/tracker.js');

// ---------------------------------------------------------------------------
// Discord client (exported so other modules may reference it if needed)
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------

/** @type {import('discord.js').SlashCommandBuilder[]} */
const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Link a Rust server to this Discord channel')
    .addStringOption((opt) =>
      opt.setName('ip').setDescription('Rust server IP address').setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('port')
        .setDescription('Rust server app port (usually 28082)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(65535)
    )
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Discord channel to receive Rust+ notifications')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    ),

  new SlashCommandBuilder()
    .setName('devices')
    .setDescription('List all smart devices paired with this guild\'s Rust server'),

  new SlashCommandBuilder()
    .setName('switch')
    .setDescription('Toggle a smart switch on or off')
    .addStringOption((opt) =>
      opt.setName('name').setDescription('Name of the switch device').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('state')
        .setDescription('Desired state')
        .setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })
    ),

  new SlashCommandBuilder()
    .setName('alarm')
    .setDescription('Check the current state of a smart alarm')
    .addStringOption((opt) =>
      opt.setName('name').setDescription('Name of the alarm device').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('storage')
    .setDescription('View the contents of a storage monitor')
    .addStringOption((opt) =>
      opt.setName('name').setDescription('Name of the storage monitor device').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show all active Rust+ WebSocket connections'),

  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a message to Rust team chat')
    .addStringOption((opt) =>
      opt.setName('message').setDescription('Message to send').setRequired(true)
    ),

  // --- ADDED: /timers command ---
  new SlashCommandBuilder()
    .setName('timers')
    .setDescription('Show current Cargo, Heli, Bradley, and Oil Rig event timers'),

  // --- ADDED: BattleMetrics commands ---
  new SlashCommandBuilder()
    .setName('track')
    .setDescription('Track a player — get notified when they join or leave')
    .addStringOption((opt) =>
      opt.setName('name').setDescription('Player name to track').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('untrack')
    .setDescription('Stop tracking a player')
    .addStringOption((opt) =>
      opt.setName('name').setDescription('Player name to stop tracking').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('online')
    .setDescription('Show BattleMetrics player count and tracked players currently online'),

  new SlashCommandBuilder()
    .setName('whois')
    .setDescription('Look up a player on BattleMetrics')
    .addStringOption((opt) =>
      opt.setName('name').setDescription('Player name to look up').setRequired(true)
    ),

  // --- ADDED: /stats command ---
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Get a player\'s wipe stats from moose.gg (Rusty Moose servers only)')
    .addStringOption((opt) =>
      opt.setName('name').setDescription('Player name to look up').setRequired(true)
    ),
];

// ---------------------------------------------------------------------------
// Helper — query DB for a guild's server pairing
// ---------------------------------------------------------------------------

/**
 * Retrieve the first server_pairings row for a given Discord guild.
 *
 * @param {string} guildId
 * @returns {{ id: number, rust_server_ip: string, rust_server_port: number,
 *             discord_guild_id: string, discord_channel_id: string,
 *             user_steam_id: string }|undefined}
 */
function getPairingForGuild(guildId) {
  const stmt = db.prepare(
    'SELECT * FROM server_pairings WHERE discord_guild_id = ? ORDER BY created_at DESC LIMIT 1'
  );
  return stmt.get(guildId);
}

/**
 * Retrieve a device from the devices table by name for a given guild.
 * Looks up the pairing first to scope by server IP/port.
 *
 * @param {string} guildId
 * @param {string} deviceName  — case-insensitive match
 * @returns {{ entity_id: string, device_type: string, name: string,
 *             rust_server_ip: string, rust_server_port: number }|undefined}
 */
function getDeviceByName(guildId, deviceName) {
  const pairing = getPairingForGuild(guildId);
  if (!pairing) return undefined;

  const stmt = db.prepare(
    `SELECT * FROM devices
     WHERE rust_server_ip = ?
       AND rust_server_port = ?
       AND lower(name) = lower(?)
     LIMIT 1`
  );
  return stmt.get(pairing.rust_server_ip, pairing.rust_server_port, deviceName);
}

// ---------------------------------------------------------------------------
// Helper — send a safe ephemeral error reply
// ---------------------------------------------------------------------------

/**
 * Reply to an interaction with an ephemeral error message.
 * Safely handles both un-replied and already-deferred states.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} message
 */
async function replyError(interaction, message) {
  const payload = { content: `\u274C ${message}`, ephemeral: true };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (err) {
    console.error('[Bot] Failed to send error reply:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Slash command handlers
// ---------------------------------------------------------------------------

/**
 * /setup ip port channel
 * Links a Rust server to a Discord channel for this guild.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleSetup(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const ip      = interaction.options.getString('ip', true).trim();
  const port    = interaction.options.getInteger('port', true);
  const channel = interaction.options.getChannel('channel', true);
  const guildId = interaction.guildId;

  // Basic IP format validation (IPv4 or hostname)
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;
  if (!ipv4Regex.test(ip) && !hostnameRegex.test(ip)) {
    return replyError(interaction, `Invalid IP address or hostname: \`${ip}\``);
  }

  // Insert or replace the pairing for this guild
  // We use a placeholder steam_id of 'discord' since no Steam auth is linked yet
  try {
    const upsert = db.prepare(`
      INSERT INTO server_pairings
        (user_steam_id, rust_server_ip, rust_server_port, discord_guild_id, discord_channel_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    upsert.run('discord', ip, port, guildId, channel.id);

    console.log(`[Bot] /setup: guild=${guildId} linked ${ip}:${port} → channel #${channel.name}`);

    // Attempt to create a Rust+ connection (will fail gracefully if no token,
    // since we are using a placeholder steam config here)
    try {
      const newConn = createConnection({
        steamId:     'discord',
        playerToken: 0,
        server:      { ip, port },
        guildId,
        channelId:   channel.id,
      });

      // Wire Discord event-forwarding for this new connection.
      // Guard with _discordEventsWired so this is idempotent.
      if (newConn && !newConn._discordEventsWired) {
        newConn._discordEventsWired = true;
        wireConnectionEvents(newConn);
      }
    } catch (connErr) {
      // Connection failure is non-fatal — pairing is stored regardless
      console.warn(`[Bot] /setup: createConnection failed (expected without real token): ${connErr.message}`);
    }

    await interaction.editReply({
      content: `\u2705 Rust server \`${ip}:${port}\` linked to <#${channel.id}>`,
    });
  } catch (err) {
    console.error('[Bot] /setup error:', err);
    await replyError(interaction, `Database error: ${err.message}`);
  }
}

/**
 * /devices
 * Lists all smart devices for this guild's Rust server.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleDevices(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const pairing = getPairingForGuild(interaction.guildId);
  if (!pairing) {
    return replyError(interaction, 'No Rust server linked to this guild. Use /setup first.');
  }

  const stmt = db.prepare(
    `SELECT * FROM devices
     WHERE rust_server_ip = ? AND rust_server_port = ?
     ORDER BY device_type, name`
  );
  const devices = stmt.all(pairing.rust_server_ip, pairing.rust_server_port);

  if (devices.length === 0) {
    return interaction.editReply({
      content: `No devices found for \`${pairing.rust_server_ip}:${pairing.rust_server_port}\`.`,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('Smart Devices')
    .setColor(0x5865F2)
    .setDescription(`Server: \`${pairing.rust_server_ip}:${pairing.rust_server_port}\``)
    .setTimestamp();

  for (const device of devices) {
    embed.addFields({
      name: `${device.name || '(unnamed)'} — ${device.device_type || 'Unknown'}`,
      value: `Entity ID: \`${device.entity_id}\``,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

/**
 * /switch name state
 * Toggles a smart switch via the Rust+ connection.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleSwitch(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const deviceName = interaction.options.getString('name', true);
  const state      = interaction.options.getString('state', true); // 'on' | 'off'
  const guildId    = interaction.guildId;

  const pairing = getPairingForGuild(guildId);
  if (!pairing) {
    return replyError(interaction, 'No Rust server linked to this guild. Use /setup first.');
  }

  const device = getDeviceByName(guildId, deviceName);
  if (!device) {
    return replyError(interaction, `Device '${deviceName}' not found.`);
  }

  const connection = getConnection(pairing.rust_server_ip, pairing.rust_server_port);
  if (!connection || !connection.isConnected()) {
    return replyError(
      interaction,
      `Rust+ connection to \`${pairing.rust_server_ip}:${pairing.rust_server_port}\` is not active.`
    );
  }

  const rustClient = connection.getClient();
  const entityId   = Number(device.entity_id);
  const value      = state === 'on';
  const username   = interaction.member?.displayName || interaction.user.username;

  try {
    await new Promise((resolve, reject) => {
      rustClient.setEntityValue(entityId, value, (message) => {
        if (message.response && message.response.error) {
          reject(new Error(message.response.error.error || 'Unknown Rust+ error'));
        } else {
          resolve(message);
        }
      });
    });

    // --- ADDED: Notify Rust+ team chat about the Discord-triggered switch toggle ---
    // Format: "checkmark [name] turned [on/off] by [Discord username]"
    try {
      rustClient.sendTeamMessage(`\u2705 ${deviceName} turned ${state} by ${username}`);
    } catch (chatErr) {
      console.warn('[Bot] /switch: sendTeamMessage failed:', chatErr.message);
    }

    console.log(`[Bot] /switch: ${username} turned ${deviceName} (${entityId}) ${state}`);
    await interaction.editReply({
      content: `\u2705 Switch \`${deviceName}\` turned **${state}**.`,
    });
  } catch (err) {
    console.error('[Bot] /switch error:', err);
    await replyError(interaction, `Failed to toggle switch: ${err.message}`);
  }
}

/**
 * /alarm name
 * Queries the current state of a smart alarm.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleAlarm(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const deviceName = interaction.options.getString('name', true);
  const guildId    = interaction.guildId;

  const pairing = getPairingForGuild(guildId);
  if (!pairing) {
    return replyError(interaction, 'No Rust server linked to this guild. Use /setup first.');
  }

  const device = getDeviceByName(guildId, deviceName);
  if (!device) {
    return replyError(interaction, `Device '${deviceName}' not found.`);
  }

  const connection = getConnection(pairing.rust_server_ip, pairing.rust_server_port);
  if (!connection || !connection.isConnected()) {
    return replyError(
      interaction,
      `Rust+ connection to \`${pairing.rust_server_ip}:${pairing.rust_server_port}\` is not active.`
    );
  }

  const rustClient = connection.getClient();
  const entityId   = Number(device.entity_id);

  try {
    const info = await new Promise((resolve, reject) => {
      rustClient.getEntityInfo(entityId, (message) => {
        if (message.response && message.response.error) {
          reject(new Error(message.response.error.error || 'Unknown Rust+ error'));
        } else if (message.response && message.response.entityInfo) {
          resolve(message.response.entityInfo);
        } else {
          reject(new Error('Unexpected response format from Rust+'));
        }
      });
    });

    const isActive = info.payload && info.payload.value === true;

    const embed = new EmbedBuilder()
      .setTitle(`Alarm: ${deviceName}`)
      .setColor(isActive ? 0xFF0000 : 0x57F287)
      .addFields(
        { name: 'Status', value: isActive ? 'TRIGGERED / Active' : 'Inactive', inline: true },
        { name: 'Entity ID', value: `\`${entityId}\``, inline: true },
        { name: 'Server', value: `\`${pairing.rust_server_ip}:${pairing.rust_server_port}\``, inline: false }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[Bot] /alarm error:', err);
    await replyError(interaction, `Failed to query alarm: ${err.message}`);
  }
}

/**
 * /storage name
 * Queries the contents of a storage monitor.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleStorage(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const deviceName = interaction.options.getString('name', true);
  const guildId    = interaction.guildId;

  const pairing = getPairingForGuild(guildId);
  if (!pairing) {
    return replyError(interaction, 'No Rust server linked to this guild. Use /setup first.');
  }

  const device = getDeviceByName(guildId, deviceName);
  if (!device) {
    return replyError(interaction, `Device '${deviceName}' not found.`);
  }

  const connection = getConnection(pairing.rust_server_ip, pairing.rust_server_port);
  if (!connection || !connection.isConnected()) {
    return replyError(
      interaction,
      `Rust+ connection to \`${pairing.rust_server_ip}:${pairing.rust_server_port}\` is not active.`
    );
  }

  const rustClient = connection.getClient();
  const entityId   = Number(device.entity_id);

  try {
    const info = await new Promise((resolve, reject) => {
      rustClient.getEntityInfo(entityId, (message) => {
        if (message.response && message.response.error) {
          reject(new Error(message.response.error.error || 'Unknown Rust+ error'));
        } else if (message.response && message.response.entityInfo) {
          resolve(message.response.entityInfo);
        } else {
          reject(new Error('Unexpected response format from Rust+'));
        }
      });
    });

    const items    = (info.payload && info.payload.items) || [];
    const capacity = (info.payload && info.payload.capacity) || 0;

    const embed = new EmbedBuilder()
      .setTitle(`Storage Monitor: ${deviceName}`)
      .setColor(0xFEE75C)
      .addFields(
        { name: 'Entity ID', value: `\`${entityId}\``, inline: true },
        { name: 'Capacity', value: `${items.length} / ${capacity}`, inline: true },
        { name: 'Server', value: `\`${pairing.rust_server_ip}:${pairing.rust_server_port}\``, inline: false }
      )
      .setTimestamp();

    if (items.length > 0) {
      // Format item list — item IDs are numeric in Rust; display them raw
      // (translating item IDs to names would require a separate item manifest)
      const itemLines = items.map((item) => {
        const bp = item.itemIsBlueprint ? ' (BP)' : '';
        return `Item ID \`${item.itemId}\` x${item.quantity}${bp}`;
      });
      embed.addFields({
        name: 'Contents',
        value: itemLines.join('\n').slice(0, 1024), // Discord embed field limit
        inline: false,
      });
    } else {
      embed.addFields({ name: 'Contents', value: 'Empty', inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[Bot] /storage error:', err);
    await replyError(interaction, `Failed to query storage: ${err.message}`);
  }
}

/**
 * /status
 * Shows all active Rust+ WebSocket connections.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleStatus(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const allConnections = getAllConnections();

  const embed = new EmbedBuilder()
    .setTitle('Rust+ Connection Status')
    .setTimestamp();

  if (allConnections.length === 0) {
    embed
      .setColor(0xED4245) // red
      .setDescription('No active connections registered.');
  } else {
    embed.setColor(0x57F287); // green — at least one connection registered

    for (const conn of allConnections) {
      const status    = conn.isConnected() ? 'Connected' : 'Disconnected';
      const colorHint = conn.isConnected() ? '' : ' (offline)';
      embed.addFields({
        name: `${conn.serverIp}:${conn.serverPort}${colorHint}`,
        value: `Status: **${status}**\nGuild: \`${conn.guildId || 'N/A'}\``,
        inline: true,
      });
    }
  }

  await interaction.editReply({ embeds: [embed] });
}

/**
 * /say message
 * Sends a message to the Rust team chat via the Rust+ connection.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleSay(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const message = interaction.options.getString('message', true);
  const guildId = interaction.guildId;
  const username = interaction.member?.displayName || interaction.user.username;

  const pairing = getPairingForGuild(guildId);
  if (!pairing) {
    return replyError(interaction, 'No Rust server linked to this guild. Use /setup first.');
  }

  const connection = getConnection(pairing.rust_server_ip, pairing.rust_server_port);
  if (!connection || !connection.isConnected()) {
    return replyError(
      interaction,
      `Rust+ connection to \`${pairing.rust_server_ip}:${pairing.rust_server_port}\` is not active.`
    );
  }

  const rustClient = connection.getClient();
  const chatMessage = `[Discord] ${username}: ${message}`;

  try {
    rustClient.sendTeamMessage(chatMessage, (response) => {
      console.log('[Bot] /say sendTeamMessage response:', JSON.stringify(response));
    });
    console.log(`[Bot] /say: ${username} sent team message: ${message}`);
    await interaction.editReply({ content: '\u2705 Message sent to team chat.' });
  } catch (err) {
    console.error('[Bot] /say error:', err);
    await replyError(interaction, `Failed to send message: ${err.message}`);
  }
}

/**
 * /timers
 * Shows current Cargo Ship, Patrol Heli, Bradley APC, and Oil Rig event timers.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleTimers(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const guildId = interaction.guildId;

  const pairing = getPairingForGuild(guildId);
  if (!pairing) {
    return replyError(interaction, 'No Rust server linked to this guild. Use /setup first.');
  }

  const ip   = pairing.rust_server_ip;
  const port = pairing.rust_server_port;

  const summary = getTimerSummary(ip, port);

  const embed = new EmbedBuilder()
    .setTitle('\u23F1\uFE0F Event Timers')
    .setDescription(summary)
    .setColor(0x5865F2)
    .setFooter({ text: `Server: ${ip}:${port}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// BattleMetrics slash command handlers
// ---------------------------------------------------------------------------

/**
 * Resolve the BM server ID for the guild's linked Rust server.
 * Returns { pairing, bmServerId } or sends an error reply and returns null.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<{ pairing: object, bmServerId: string }|null>}
 */
async function resolveBmServer(interaction) {
  const pairing = getPairingForGuild(interaction.guildId);
  if (!pairing) {
    await replyError(interaction, 'No Rust server linked to this guild. Use /setup first.');
    return null;
  }

  let bmServerId = bmTracker.getBmServerId(pairing.rust_server_ip, pairing.rust_server_port);

  if (!bmServerId) {
    // Try to find + cache it now (may take a moment)
    const conn = getConnection(pairing.rust_server_ip, pairing.rust_server_port);
    if (conn) {
      const row = await bmTracker.findAndCacheBmServer(conn).catch(() => null);
      bmServerId = row ? row.bm_server_id : null;
    }
  }

  if (!bmServerId) {
    await replyError(
      interaction,
      'Could not find this server on BattleMetrics. ' +
      'Make sure the server IP is publicly listed on battlemetrics.com.'
    );
    return null;
  }

  return { pairing, bmServerId };
}

/**
 * /track name:<player>
 * Find the player on BM and add them to the tracked_players table.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleTrack(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const ctx = await resolveBmServer(interaction);
  if (!ctx) return;

  const name = interaction.options.getString('name', true);

  let results;
  try {
    results = await bmApi.searchPlayer(name, ctx.bmServerId);
  } catch (e) {
    console.error('[Bot] /track BM search error:', e);
    return replyError(interaction, `BattleMetrics search failed: ${e.message}`);
  }

  if (!results || results.length === 0) {
    return replyError(
      interaction,
      `No player named **${name}** found on this server's BattleMetrics history.`
    );
  }

  const player = results[0]; // best match

  try {
    db.prepare(`
      INSERT INTO tracked_players (bm_server_id, bm_player_id, player_name, is_online, added_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(bm_server_id, bm_player_id) DO UPDATE SET
        player_name = excluded.player_name,
        added_by    = excluded.added_by
    `).run(ctx.bmServerId, player.id, player.name, player.online ? 1 : 0, interaction.user.tag);
  } catch (e) {
    console.error('[Bot] /track DB error:', e);
    return replyError(interaction, `Failed to save tracking entry: ${e.message}`);
  }

  const statusStr = player.online ? '🟢 Currently online' : '🔴 Currently offline';

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('✅ Now Tracking Player')
    .addFields(
      { name: 'Player',  value: `**${player.name}**`,   inline: true },
      { name: 'BM ID',   value: `\`${player.id}\``,     inline: true },
      { name: 'Status',  value: statusStr,               inline: true },
    )
    .setDescription('You will be notified in team chat and Discord when this player joins or leaves.')
    .setFooter({ text: 'BattleMetrics Tracker' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  console.log(`[Bot] /track: ${interaction.user.tag} tracking "${player.name}" (${player.id})`);
}

/**
 * /untrack name:<player>
 * Remove a player from the tracked_players table.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleUntrack(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const ctx = await resolveBmServer(interaction);
  if (!ctx) return;

  const name = interaction.options.getString('name', true).toLowerCase();

  const row = db.prepare(
    "SELECT * FROM tracked_players WHERE bm_server_id = ? AND lower(player_name) LIKE ?"
  ).get(ctx.bmServerId, `%${name}%`);

  if (!row) {
    return replyError(interaction, `No tracked player matching **${name}** found.`);
  }

  db.prepare('DELETE FROM tracked_players WHERE id = ?').run(row.id);

  const embed = new EmbedBuilder()
    .setColor(0xffa500)
    .setTitle('🛑 Stopped Tracking Player')
    .setDescription(`**${row.player_name}** has been removed from the tracker.`)
    .setFooter({ text: 'BattleMetrics Tracker' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  console.log(`[Bot] /untrack: ${interaction.user.tag} untracked "${row.player_name}"`);
}

/**
 * /online
 * Show current BM player count and which tracked players are online.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleOnline(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const ctx = await resolveBmServer(interaction);
  if (!ctx) return;

  let serverInfo;
  try {
    serverInfo = await bmApi.getServerInfo(ctx.bmServerId);
  } catch (e) {
    return replyError(interaction, `BattleMetrics request failed: ${e.message}`);
  }

  const trackedRows = db.prepare(
    'SELECT * FROM tracked_players WHERE bm_server_id = ? ORDER BY player_name ASC'
  ).all(ctx.bmServerId);

  const onlineTracked  = trackedRows.filter((r) => r.is_online === 1);
  const offlineTracked = trackedRows.filter((r) => r.is_online !== 1);

  const trackedLines = [
    ...onlineTracked.map( (r) => `🟢 ${r.player_name}`),
    ...offlineTracked.map((r) => `🔴 ${r.player_name}`),
  ];

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🌐 ${serverInfo ? serverInfo.name : 'Server'} — Player Info`)
    .addFields(
      {
        name:   '👥 Online Now',
        value:  serverInfo
          ? `${serverInfo.players} / ${serverInfo.maxPlayers}`
          : 'Unknown',
        inline: true,
      },
      {
        name:   '🎯 Tracked Players',
        value:  trackedLines.length ? trackedLines.join('\n') : 'None tracked yet',
        inline: false,
      }
    )
    .setFooter({ text: 'BattleMetrics · updates every 60 s' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/**
 * /whois name:<player>
 * Search BM for a player and display their profile.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleWhois(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const ctx = await resolveBmServer(interaction);
  if (!ctx) return;

  const name = interaction.options.getString('name', true);

  let results;
  try {
    results = await bmApi.searchPlayer(name, ctx.bmServerId);
  } catch (e) {
    return replyError(interaction, `BattleMetrics search failed: ${e.message}`);
  }

  if (!results || results.length === 0) {
    return replyError(interaction, `No player named **${name}** found on this server's BM history.`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🔍 BattleMetrics — Whois: ${name}`)
    .setFooter({ text: 'BattleMetrics Player Lookup' })
    .setTimestamp();

  const fields = results.slice(0, 5).map((p) => ({
    name:   p.name,
    value:  `BM ID: \`${p.id}\`\nStatus: ${p.online ? '🟢 Online' : '🔴 Offline'}\n[View Profile](https://www.battlemetrics.com/players/${p.id})`,
    inline: true,
  }));

  embed.addFields(fields);

  await interaction.editReply({ embeds: [embed] });
}

/**
 * /stats name:<player>
 * Fetch wipe stats from moose.gg (Rusty Moose servers only).
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleStats(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const ctx = await resolveBmServer(interaction);
  if (!ctx) return;

  const name = interaction.options.getString('name', true);

  // Look up the BM server name so we can pick the right moose.gg server
  const bmRow = db.prepare('SELECT bm_server_name FROM bm_servers WHERE bm_server_id = ?')
    .get(ctx.bmServerId);
  const bmServerName = bmRow ? bmRow.bm_server_name : null;

  let result;
  try {
    const moose = require('../stats/moose.js');
    result = await moose.getMooseStats(name, bmServerName);
  } catch (e) {
    console.error('[Bot] /stats moose.gg error:', e);
    return replyError(interaction, `Failed to fetch moose.gg stats: ${e.message}`);
  }

  if (result.error) {
    return replyError(interaction, result.error);
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`\uD83D\uDCCA Wipe Stats \u2014 ${result.name}`)
    .addFields(
      { name: '\u2694\uFE0F KDR',         value: result.kdr,       inline: true },
      { name: '\uD83E\uDEA8 Sulfur Ore',  value: result.sulfurOre, inline: true },
      { name: '\uD83D\uDE80 Rockets',     value: result.rockets,   inline: true },
    )
    .setDescription(`**Server:** ${result.server}\n**Wipe:** ${result.wipe}`)
    .setFooter({ text: 'moose.gg · Rusty Moose Stats' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  console.log(`[Bot] /stats: fetched stats for "${result.name}" on ${result.server}`);
}

// ---------------------------------------------------------------------------
// Interaction router
// ---------------------------------------------------------------------------

/** @type {Map<string, (interaction: import('discord.js').ChatInputCommandInteraction) => Promise<void>>} */
const commandHandlers = new Map([
  ['setup',    handleSetup],
  ['devices',  handleDevices],
  ['switch',   handleSwitch],
  ['alarm',    handleAlarm],
  ['storage',  handleStorage],
  ['status',   handleStatus],
  ['say',      handleSay],
  ['timers',   handleTimers],
  // --- ADDED: BattleMetrics commands ---
  ['track',    handleTrack],
  ['untrack',  handleUntrack],
  ['online',   handleOnline],
  ['whois',    handleWhois],
  // --- ADDED: moose.gg stats ---
  ['stats',    handleStats],
]);

// ---------------------------------------------------------------------------
// Ollama LLM helper — used by !ask team chat command
// ---------------------------------------------------------------------------

/**
 * Ask a question to the locally-running Ollama instance and get a short answer.
 * Uses http (no external deps). Calls back with (err, answerString).
 *
 * Configurable via env vars:
 *   OLLAMA_HOST  — default 127.0.0.1
 *   OLLAMA_PORT  — default 11434
 *   OLLAMA_MODEL — default llama3
 *
 * @param {string} question
 * @param {function(Error|null, string|null): void} callback
 */
function askOllama(question, callback) {
  const http = require('http');
  const host  = process.env.OLLAMA_HOST  || '127.0.0.1';
  const port  = parseInt(process.env.OLLAMA_PORT  || '11434', 10);
  const model = process.env.OLLAMA_MODEL || 'llama3';

  const body = JSON.stringify({
    model,
    messages: [
      {
        role: 'system',
        content: [
          'You are an assistant that ONLY answers questions about the video game Rust (the survival game by Facepunch Studios).',
          'Every question is about Rust gameplay. Never assume a question is about anything other than the game Rust.',
          'Answer in 1-2 short sentences. Keep your reply under 200 characters.',
          '',
          'RAID COSTS (exact — do not guess):',
          'Wood Wall: 2 Rockets / 1 C4 / 3 Satchels',
          'Stone Wall: 10 Rockets / 4 C4 / 10 Satchels',
          'Sheet Metal Wall: 23 Rockets / 8 C4 / 23 Satchels',
          'Armored Wall: 46 Rockets / 15 C4 / 46 Satchels',
          'Wood Door: 2 Rockets / 1 C4 / 2 Satchels',
          'Sheet Metal Door: 4 Rockets / 2 C4 / 4 Satchels',
          'Garage Door: 9 Rockets / 3 C4 / 9 Satchels',
          'Armored Door: 12 Rockets / 4 C4 / 12 Satchels',
          '',
          'MONUMENT KEYCARD PUZZLES (every card slot also needs 1 electric fuse):',
          'Green card only: Gas Station, Supermarket, Junkyard',
          'Blue card only: Sewer Branch, Satellite Dish, Airfield, Train Yard, Water Treatment, Large Harbor',
          'Green then Blue then Red (full chain, 3 fuses): Power Plant, Launch Site',
          'Blue entry + Red loot room (2 fuses): Military Tunnel',
          'No cards: Dome (bring 25+ rad protection), Outpost, Bandit Camp',
          '',
          'RADIATION PROTECTION NEEDED (clothing rad rating):',
          'Dome: 25+ | Military Tunnel: 15+ | Launch Site: 15+ | Airfield: 10+ | Outpost/Bandit: none',
          '',
          'BEST LOOT MONUMENTS (ranked): Launch Site > Military Tunnel > Large Oil Rig > Small Oil Rig > Airfield > Power Plant',
          '',
          'RECYCLER LOCATIONS: Outpost, Bandit Camp, Airfield, Harbor, Lighthouse, Supermarket, Sewer Branch, Junkyard',
          '',
          'WORKBENCH TIERS: WB1 = basic components/ammo | WB2 = mid-tier weapons (SMG, semi-auto) | WB3 = end-game (AK47, L96, M249)',
          '',
          'SAFE ZONES: Outpost and Bandit Camp — cannot attack players, use scrap to buy items from NPC vendors',
          '',
          'OIL RIG: Small Rig = 2 scientists + 1 locked crate. Large Rig = 16 scientists + 2 locked crates, needs keycard found inside.',
          '',
          'CARGO SHIP: Moves around map, has scientists, blue/red card rooms, and 1 locked crate. Leaves after ~30-50 min.',
          '',
          'PATROL HELICOPTER: Attacks players outside with no roof cover. Drops 2-4 crates on death with high-tier loot.',
          '',
          'BRADLEY APC: Patrols Launch Site. Drops 3-4 crates. Use explosives or incendiary rockets. Respawns ~30 min.',
        ].join('\n'),
      },
      { role: 'user', content: question },
    ],
    stream: false,
  });

  const req = http.request(
    {
      hostname: host,
      port,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json   = JSON.parse(data);
          const answer = (json.message && json.message.content)
            ? json.message.content.trim()
            : '';
          // Rust+ team chat has ~256 char limit — stay well inside it
          const trimmed = answer.length > 200
            ? answer.slice(0, 197) + '...'
            : answer;
          callback(null, trimmed || 'No response from AI.');
        } catch (err) {
          callback(err, null);
        }
      });
    }
  );

  req.on('error', (err) => callback(err, null));

  req.setTimeout(20000, () => {
    req.destroy();
    callback(new Error('Ollama request timed out'), null);
  });

  req.write(body);
  req.end();
}

// ---------------------------------------------------------------------------
// Raid cost lookup — used by !raid team chat command
// ---------------------------------------------------------------------------

/**
 * Ordered lookup table of raid costs.
 * Entries are checked top-to-bottom — more specific entries (doors, garage)
 * must come before generic wall entries so keyword matching doesn't false-fire.
 */
const RAID_TABLE = [
  {
    keys:    ['garage'],
    label:   'Garage Door',
    rockets: 9,  c4: 3,  satchels: 9,
  },
  {
    keys:    ['armored door', 'armoured door', 'armor door', 'armour door'],
    label:   'Armored Door',
    rockets: 12, c4: 4,  satchels: 12,
  },
  {
    keys:    ['sheet door', 'metal door', 'sheet metal door'],
    label:   'Sheet Metal Door',
    rockets: 4,  c4: 2,  satchels: 4,
  },
  {
    keys:    ['wood door', 'wooden door'],
    label:   'Wood Door',
    rockets: 2,  c4: 1,  satchels: 2,
  },
  {
    keys:    ['armored wall', 'armoured wall', 'armored', 'armoured'],
    label:   'Armored Wall',
    rockets: 46, c4: 15, satchels: 46,
  },
  {
    keys:    ['sheet metal wall', 'sheet metal', 'metal wall', 'metal'],
    label:   'Sheet Metal Wall',
    rockets: 23, c4: 8,  satchels: 23,
  },
  {
    keys:    ['stone wall', 'stone'],
    label:   'Stone Wall',
    rockets: 10, c4: 4,  satchels: 10,
  },
  {
    keys:    ['wood wall', 'wooden wall', 'wood', 'wooden'],
    label:   'Wood Wall',
    rockets: 2,  c4: 1,  satchels: 3,
  },
];

/**
 * Look up raid costs for a target string using keyword matching.
 * Returns the matching RAID_TABLE entry or null if not found.
 * @param {string} target  — e.g. "stone wall", "garage", "metal door"
 * @returns {object|null}
 */
function getRaidCost(target) {
  const q = target.toLowerCase().trim();
  for (const entry of RAID_TABLE) {
    for (const key of entry.keys) {
      if (q.includes(key)) return entry;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Event forwarding — rustplus → Discord
// ---------------------------------------------------------------------------

/**
 * Wire event forwarding for a single RustPlusConnection instance.
 * Looks up the Discord channel from the connection's channelId property
 * (set when createConnection was called from /setup).
 *
 * @param {import('../rustplus/index.js').RustPlusConnection} connection
 */
function wireConnectionEvents(connection) {
  const serverLabel = `${connection.serverIp}:${connection.serverPort}`;

  /**
   * Resolve the Discord text channel for this connection.
   * Falls back to querying the DB if the connection has no cached channelId.
   * @returns {import('discord.js').TextChannel|null}
   */
  function resolveChannel() {
    // Use the channelId stored on the connection object (set during /setup)
    let channelId = connection.channelId;

    // If not on the object, look it up from the DB using guildId
    if (!channelId && connection.guildId) {
      const pairing = getPairingForGuild(connection.guildId);
      if (pairing) channelId = pairing.discord_channel_id;
    }

    // As a final fallback, search all pairings by server ip:port
    if (!channelId) {
      const stmt = db.prepare(
        'SELECT * FROM server_pairings WHERE rust_server_ip = ? AND rust_server_port = ? LIMIT 1'
      );
      const row = stmt.get(connection.serverIp, connection.serverPort);
      if (row) channelId = row.discord_channel_id;
    }

    if (!channelId) {
      console.warn(`[Bot] No Discord channel configured for server ${serverLabel} — skipping event forward`);
      return null;
    }

    const channel = client.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) {
      console.warn(`[Bot] Cached channel ${channelId} not found or not text-based`);
      return null;
    }
    return channel;
  }

  // -- teamChat ------------------------------------------------------------
  connection.on('teamChat', (payload) => {
    const channel = resolveChannel();
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle('\uD83D\uDCAC Team Chat')
      .setDescription(`**${payload.playerName || payload.steamId}**: ${payload.message}`)
      .setColor(0x5865F2)
      .setTimestamp(payload.time ? new Date(payload.time * 1000) : new Date())
      .setFooter({ text: serverLabel });

    channel.send({ embeds: [embed] }).catch((err) =>
      console.error(`[Bot] Failed to forward teamChat to Discord: ${err.message}`)
    );
  });

  // -- alarmTriggered ------------------------------------------------------
  connection.on('alarmTriggered', (payload) => {
    const channel = resolveChannel();
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle('\u26A0\uFE0F Alarm Triggered!')
      .setDescription(`Entity ID: \`${payload.entityId}\``)
      .setColor(0xFF0000)
      .addFields(
        { name: 'Server', value: `\`${serverLabel}\``, inline: true },
        { name: 'Timestamp', value: new Date().toUTCString(), inline: false }
      )
      .setTimestamp();

    // @here goes in message content (not inside embed) so it actually pings
    channel.send({ content: '@here', embeds: [embed] }).catch((err) =>
      console.error(`[Bot] Failed to forward alarmTriggered to Discord: ${err.message}`)
    );
  });

  // -- storageUpdated ------------------------------------------------------
  connection.on('storageUpdated', (payload) => {
    const channel = resolveChannel();
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle('\uD83D\uDCE6 Storage Monitor Update')
      .setColor(0xFEE75C)
      .addFields(
        { name: 'Entity ID', value: `\`${payload.entityId}\``, inline: true },
        { name: 'Items', value: String(payload.items ? payload.items.length : 0), inline: true },
        { name: 'Capacity', value: String(payload.capacity || 0), inline: true }
      )
      .setFooter({ text: serverLabel })
      .setTimestamp();

    channel.send({ embeds: [embed] }).catch((err) =>
      console.error(`[Bot] Failed to forward storageUpdated to Discord: ${err.message}`)
    );
  });

  // -- switchChanged -------------------------------------------------------
  connection.on('switchChanged', (payload) => {
    const channel = resolveChannel();
    if (!channel) return;

    const stateStr = payload.value ? 'ON' : 'OFF';

    const embed = new EmbedBuilder()
      .setTitle('\u26A1 Switch Changed')
      .setColor(0x57F287)
      .addFields(
        { name: 'Entity ID', value: `\`${payload.entityId}\``, inline: true },
        { name: 'New State', value: `**${stateStr}**`, inline: true }
      )
      .setFooter({ text: serverLabel })
      .setTimestamp();

    channel.send({ embeds: [embed] }).catch((err) =>
      console.error(`[Bot] Failed to forward switchChanged to Discord: ${err.message}`)
    );
  });

  // -- teamChat !commands --------------------------------------------------
  // Listen for team chat messages starting with '!' and respond with timer info.
  connection.on('teamChat', (payload) => {
    const text = (payload.message || '').trim();
    if (!text.startsWith('!')) return;

    const cmd = text.toLowerCase().split(/\s+/)[0]; // e.g. '!cargo'
    const timers = getTimerState(connection.serverIp, connection.serverPort);
    const rustClient = connection.getClient();

    // Helper to send a response — works even if timers state is not yet populated
    function reply(msg) {
      console.log(`[Bot] reply() called: rustClient=${rustClient ? 'ok' : 'NULL'}, msg="${msg}"`);
      try {
        if (rustClient) {
          rustClient.sendTeamMessage(msg, (res) => {
            if (res && res.response && res.response.error) {
              console.warn(`[Bot] ${cmd} reply error:`, res.response.error.error);
            } else {
              console.log(`[Bot] ${cmd} reply sent ok`);
            }
          });
        } else {
          console.warn(`[Bot] ${cmd} reply skipped — rustClient is null`);
        }
      } catch (err) {
        console.warn(`[Bot] ${cmd} sendTeamMessage failed:`, err.message);
      }
    }

    console.log(`[Bot] Team chat command received: ${cmd} on ${connection.serverIp}:${connection.serverPort}`);

    if (cmd === '!banana') {
      reply('Farm Wood');
    } else if (cmd === '!cargo') {
      reply(timers ? getSingleTimerMessage('cargo', timers.cargo) : '🚢 Cargo: unknown (bot just started)');
    } else if (cmd === '!heli') {
      reply(timers ? getSingleTimerMessage('heli', timers.heli) : '🚁 Heli: unknown (bot just started)');
    } else if (cmd === '!bradley') {
      reply(timers ? getSingleTimerMessage('bradley', timers.bradley) : '💥 Bradley: unknown (bot just started)');
    } else if (cmd === '!oil' || cmd === '!oilrig') {
      // Live query — checks actual map markers for current crate status and grid position
      getLiveCrateStatus(connection, (msg) => reply(msg));
    } else if (cmd === '!timers') {
      const summary = getTimerSummary(connection.serverIp, connection.serverPort);
      // Split into lines and send each as a separate message (team chat has length limits)
      const lines = summary.split('\n').filter(l => l.trim());
      try {
        for (const line of lines) {
          if (rustClient) rustClient.sendTeamMessage(line);
        }
      } catch (err) {
        console.warn('[Bot] !timers sendTeamMessage failed:', err.message);
      }
    } else if (cmd === '!raid') {
      const target = text.slice('!raid'.length).trim();
      if (!target) {
        reply('Usage: !raid <target> — e.g. !raid stone, !raid metal door, !raid garage');
        return;
      }
      const entry = getRaidCost(target);
      if (!entry) {
        reply(`Unknown target "${target}". Try: stone, metal, armored, sheet door, garage, armored door`);
      } else {
        reply(`\uD83E\uDDE8 ${entry.label}: ${entry.rockets} Rockets | ${entry.c4} C4 | ${entry.satchels} Satchels`);
      }
    } else if (cmd === '!ask') {
      const question = text.slice('!ask'.length).trim();
      if (!question) {
        reply('Usage: !ask <your question>');
        return;
      }
      reply('Thinking...');
      askOllama(question, (err, answer) => {
        if (err) {
          console.error('[Bot] !ask Ollama error:', err.message);
          reply('AI unavailable right now.');
        } else {
          console.log(`[Bot] !ask response: ${answer}`);
          reply(answer);
        }
      });

    // --- BattleMetrics team chat commands ---
    } else if (cmd === '!track') {
      const trackName = text.slice('!track'.length).trim();
      if (!trackName) { reply('Usage: !track <playername>'); return; }

      const bmServerId = bmTracker.getBmServerId(connection.serverIp, connection.serverPort);
      if (!bmServerId) { reply('BattleMetrics not linked yet. Try again in a moment.'); return; }

      bmApi.searchPlayer(trackName, bmServerId).then((results) => {
        if (!results || results.length === 0) {
          reply(`No player "${trackName}" found on BattleMetrics.`);
          return;
        }
        const player = results[0];
        db.prepare(`
          INSERT INTO tracked_players (bm_server_id, bm_player_id, player_name, is_online, added_by)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(bm_server_id, bm_player_id) DO UPDATE SET
            player_name = excluded.player_name,
            added_by    = excluded.added_by
        `).run(bmServerId, player.id, player.name, player.online ? 1 : 0,
               payload.playerName || 'TeamChat');
        const status = player.online ? '(online now)' : '(offline)';
        reply(`\uD83D\uDFE2 Now tracking ${player.name} ${status}`);
      }).catch((e) => {
        console.error('[Bot] !track error:', e.message);
        reply('BattleMetrics search failed. Try again later.');
      });

    } else if (cmd === '!untrack') {
      const untrackName = text.slice('!untrack'.length).trim().toLowerCase();
      if (!untrackName) { reply('Usage: !untrack <playername>'); return; }

      const bmServerId = bmTracker.getBmServerId(connection.serverIp, connection.serverPort);
      if (!bmServerId) { reply('BattleMetrics not linked yet.'); return; }

      const row = db.prepare(
        "SELECT * FROM tracked_players WHERE bm_server_id = ? AND lower(player_name) LIKE ?"
      ).get(bmServerId, `%${untrackName}%`);

      if (!row) {
        reply(`No tracked player matching "${untrackName}" found.`);
      } else {
        db.prepare('DELETE FROM tracked_players WHERE id = ?').run(row.id);
        reply(`\uD83D\uDED1 Stopped tracking ${row.player_name}`);
      }

    } else if (cmd === '!online') {
      const bmServerId = bmTracker.getBmServerId(connection.serverIp, connection.serverPort);
      if (!bmServerId) { reply('BattleMetrics not linked yet.'); return; }

      bmApi.getServerInfo(bmServerId).then((info) => {
        const trackedRows = db.prepare(
          'SELECT * FROM tracked_players WHERE bm_server_id = ? ORDER BY player_name ASC'
        ).all(bmServerId);

        const lines = [];
        if (info) lines.push(`\uD83C\uDF0E ${info.name}: ${info.players}/${info.maxPlayers} players`);

        const onlineTracked = trackedRows.filter((r) => r.is_online === 1);
        if (onlineTracked.length) {
          lines.push('Tracked online: ' + onlineTracked.map((r) => r.player_name).join(', '));
        } else if (trackedRows.length) {
          lines.push('No tracked players currently online');
        }

        if (lines.length === 0) lines.push('BattleMetrics data not available');
        for (const line of lines) reply(line);
      }).catch(() => reply('BattleMetrics request failed.'));

    } else if (cmd === '!whois') {
      const whoisName = text.slice('!whois'.length).trim();
      if (!whoisName) { reply('Usage: !whois <playername>'); return; }

      const bmServerId = bmTracker.getBmServerId(connection.serverIp, connection.serverPort);
      if (!bmServerId) { reply('BattleMetrics not linked yet.'); return; }

      bmApi.searchPlayer(whoisName, bmServerId).then((results) => {
        if (!results || results.length === 0) {
          reply(`No player "${whoisName}" found on BattleMetrics.`);
          return;
        }
        const lines = results.slice(0, 3).map(
          (p) => `${p.online ? '\uD83D\uDFE2' : '\uD83D\uDD34'} ${p.name} — bm.io/players/${p.id}`
        );
        for (const line of lines) reply(line);
      }).catch((e) => {
        console.error('[Bot] !whois error:', e.message);
        reply('BattleMetrics search failed.');
      });

    } else if (cmd === '!stats') {
      const statsName = text.slice('!stats'.length).trim();
      if (!statsName) { reply('Usage: !stats <playername>'); return; }

      reply('\uD83D\uDD0D Looking up stats on moose.gg...');

      const bmRow = db.prepare(
        'SELECT bm_server_name FROM bm_servers WHERE rust_server_ip = ? AND rust_server_port = ?'
      ).get(connection.serverIp, connection.serverPort);
      const bmServerName = bmRow ? bmRow.bm_server_name : null;

      const moose = require('../stats/moose.js');
      moose.getMooseStats(statsName, bmServerName).then((result) => {
        if (result.error) {
          reply(result.error);
        } else {
          reply(
            `\uD83D\uDCCA ${result.name} | KDR: ${result.kdr} | ` +
            `Sulfur: ${result.sulfurOre} | Rockets: ${result.rockets} | ` +
            `Wipe: ${result.wipe}`
          );
        }
      }).catch((e) => {
        console.error('[Bot] !stats error:', e.message);
        reply('Failed to fetch moose.gg stats. Try again in a moment.');
      });
    }
    // Unknown !command — ignore silently
  });

  // -- spawn (map marker appeared) -----------------------------------------
  // Emitted by mapPoller when a tracked entity spawns on the map.
  connection.on('spawn', (payload) => {
    const channel = resolveChannel();
    if (!channel) return;

    const titles = {
      cargo:   '\uD83D\uDEA2 Cargo Ship Spawned',
      heli:    '\uD83D\uDE81 Patrol Helicopter Incoming',
      bradley: '\uD83D\uDCA5 Bradley APC Active',
      oilrig:  '\uD83D\uDEE2\uFE0F Oil Rig Locked',
    };

    const descriptions = {
      cargo:   'Cargo Ship has appeared on the map!',
      heli:    'Patrol Helicopter is incoming!',
      bradley: 'Bradley APC is active at Launch Site!',
      oilrig:  'Oil Rig is locked — scientists have been called!',
    };

    const title = titles[payload.event]   || `${payload.event} spawned`;
    const desc  = descriptions[payload.event] || `${payload.event} has spawned.`;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(desc)
      .setColor(0x57F287) // green — spawn
      .addFields({ name: 'Spawned At', value: payload.spawnedAt ? payload.spawnedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : 'now', inline: true })
      .setFooter({ text: serverLabel })
      .setTimestamp();

    channel.send({ embeds: [embed] }).catch((err) =>
      console.error(`[Bot] Failed to forward spawn event to Discord: ${err.message}`)
    );
  });

  // -- despawn (map marker disappeared) ------------------------------------
  // Emitted by mapPoller when a tracked entity despawns from the map.
  connection.on('despawn', (payload) => {
    const channel = resolveChannel();
    if (!channel) return;

    const titles = {
      cargo:   '\uD83D\uDEA2 Cargo Ship Left',
      heli:    '\uD83D\uDE81 Patrol Helicopter Gone',
      bradley: '\uD83D\uDCA5 Bradley APC Destroyed',
      oilrig:  '\uD83D\uDEE2\uFE0F Oil Rig Crate Gone',
    };

    const descriptions = {
      cargo:   'Cargo Ship has left the map.',
      heli:    'Patrol Helicopter has been destroyed or left the map.',
      bradley: 'Bradley APC has been destroyed. Respawns in ~30 min.',
      oilrig:  'Oil Rig crate has been looted or timed out.',
    };

    const title = titles[payload.event]   || `${payload.event} despawned`;
    const desc  = descriptions[payload.event] || `${payload.event} has despawned.`;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(desc)
      .setColor(0xED4245) // red — despawn
      .addFields({ name: 'Despawned At', value: payload.despawnedAt ? payload.despawnedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : 'now', inline: true })
      .setFooter({ text: serverLabel })
      .setTimestamp();

    channel.send({ embeds: [embed] }).catch((err) =>
      console.error(`[Bot] Failed to forward despawn event to Discord: ${err.message}`)
    );
  });

  console.log(`[Bot] Event forwarding wired for connection ${serverLabel}`);
}

// ---------------------------------------------------------------------------
// Slash command registration via Discord REST API
// ---------------------------------------------------------------------------

/**
 * Register all slash commands globally (or guild-scoped if DISCORD_GUILD_ID is set).
 * Called once after the client emits 'ready'.
 *
 * @param {string} clientId
 * @param {string} token
 */
async function registerCommands(clientId, token) {
  const rest = new REST({ version: '10' }).setToken(token);
  const commandsJSON = commandDefinitions.map((cmd) => cmd.toJSON());

  const guildId = process.env.DISCORD_GUILD_ID;

  try {
    if (guildId) {
      console.log(`[Bot] Registering ${commandsJSON.length} guild-scoped commands (guild: ${guildId})...`);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandsJSON });
      console.log('[Bot] Guild-scoped slash commands registered.');
    } else {
      console.log(`[Bot] Registering ${commandsJSON.length} global slash commands...`);
      await rest.put(Routes.applicationCommands(clientId), { body: commandsJSON });
      console.log('[Bot] Global slash commands registered.');
    }
  } catch (err) {
    // Token may be a placeholder — log and continue rather than crashing
    console.error('[Bot] Failed to register slash commands:', err.message);
  }
}

// ---------------------------------------------------------------------------
// startBot — main export
// ---------------------------------------------------------------------------

/**
 * Initialise the Discord bot: register commands and connect to the gateway.
 * Safe to call even when DISCORD_BOT_TOKEN is a placeholder — errors are caught
 * and logged rather than propagated.
 *
 * @returns {Promise<void>}
 */
async function startBot() {
  const token    = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token || token === 'your_discord_bot_token_here') {
    console.warn('[Bot] DISCORD_BOT_TOKEN is not set or is a placeholder — bot will not connect to Discord.');
    return;
  }

  if (!clientId || clientId === 'your_discord_client_id_here') {
    console.warn('[Bot] DISCORD_CLIENT_ID is not set or is a placeholder — slash commands will not be registered.');
  }

  // -- client ready ---------------------------------------------------------
  client.once('ready', async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}`);
    console.log(`[Bot] Serving ${client.guilds.cache.size} guild(s)`);

    // Register slash commands
    if (clientId && clientId !== 'your_discord_client_id_here') {
      await registerCommands(clientId, token);
    }

    // Wire event forwarding for any connections already registered
    // (e.g. from previous /setup calls stored in the DB that were reconnected
    // at startup by a future boot-time routine).
    // Guard with _discordEventsWired so this is idempotent — index.js also
    // calls wireConnectionEvents after startBot() to cover connections loaded
    // in Step 5. The guard prevents double-attaching listeners.
    for (const conn of getAllConnections()) {
      if (!conn._discordEventsWired) {
        conn._discordEventsWired = true;
        wireConnectionEvents(conn);
      }
    }

    console.log('[Bot] Ready.');
  });

  // -- interaction handler --------------------------------------------------
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const handler = commandHandlers.get(interaction.commandName);
    if (!handler) return;

    console.log(`[Bot] Command /${interaction.commandName} invoked by ${interaction.user.tag} in guild ${interaction.guildId}`);

    try {
      await handler(interaction);
    } catch (err) {
      console.error(`[Bot] Unhandled error in /${interaction.commandName}:`, err);
      await replyError(interaction, `An unexpected error occurred: ${err.message}`);
    }
  });

  // -- gateway login --------------------------------------------------------
  try {
    console.log('[Bot] Connecting to Discord gateway...');
    await client.login(token);
  } catch (err) {
    // Invalid token or network failure — log clearly but do not propagate so
    // the rest of the app (web server) continues running
    console.error('[Bot] Failed to connect to Discord:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  startBot,
  client,
  wireConnectionEvents,
  getPairingForGuild,
};
