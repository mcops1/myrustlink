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
    rustClient.sendTeamMessage(chatMessage);
    console.log(`[Bot] /say: ${username} sent team message: ${message}`);
    await interaction.editReply({ content: '\u2705 Message sent to team chat.' });
  } catch (err) {
    console.error('[Bot] /say error:', err);
    await replyError(interaction, `Failed to send message: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Interaction router
// ---------------------------------------------------------------------------

/** @type {Map<string, (interaction: import('discord.js').ChatInputCommandInteraction) => Promise<void>>} */
const commandHandlers = new Map([
  ['setup',   handleSetup],
  ['devices', handleDevices],
  ['switch',  handleSwitch],
  ['alarm',   handleAlarm],
  ['storage', handleStorage],
  ['status',  handleStatus],
  ['say',     handleSay],
]);

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
