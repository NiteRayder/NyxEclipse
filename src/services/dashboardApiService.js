import { PermissionFlagsBits } from 'discord.js';
import { getGuildConfig, patchGuildConfig } from './config/guildConfig.js';
import { getModerationCases } from '../utils/moderation.js';
import { getServerCounters } from './serverstatsService.js';
import { getLoggingStatus, setLogChannel, setLoggingEnabled, toggleEventLogging } from './loggingService.js';

const DISCORD_API = 'https://discord.com/api/v10';
const authCache = new Map();
const CACHE_TTL = 60_000;

function unauthorized(message = 'Dashboard authentication required.') {
  const error = new Error(message);
  error.statusCode = 401;
  return error;
}

function forbidden(message = 'You do not have permission to manage this server.') {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

async function discordRequest(path, accessToken) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'NyxEclipse/1.0 GuildNexus',
    },
  });

  if (!response.ok) {
    const error = new Error(`Discord API request failed (${response.status}).`);
    error.statusCode = response.status === 401 ? 401 : 502;
    throw error;
  }

  return response.json();
}

export async function authenticateDashboardRequest(accessToken) {
  if (!accessToken) throw unauthorized();

  const cached = authCache.get(accessToken);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const user = await discordRequest('/users/@me', accessToken);
  const guilds = await discordRequest('/users/@me/guilds', accessToken);

  const result = { user, guilds, expiresAt: Date.now() + CACHE_TTL };
  authCache.set(accessToken, result);

  if (authCache.size > 500) {
    const oldest = authCache.keys().next().value;
    authCache.delete(oldest);
  }

  return result;
}

export async function authorizeGuild(client, accessToken, guildId) {
  const auth = await authenticateDashboardRequest(accessToken);
  const oauthGuild = auth.guilds.find((guild) => guild.id === guildId);

  if (!oauthGuild) throw forbidden('You do not have access to this server.');

  const permissions = BigInt(oauthGuild.permissions || '0');
  const canManage = oauthGuild.owner === true ||
    (permissions & PermissionFlagsBits.ManageGuild) === PermissionFlagsBits.ManageGuild ||
    (permissions & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;

  if (!canManage) throw forbidden('You need Manage Server or Administrator permission.');

  const guild = client.guilds.cache.get(guildId) ||
    await client.guilds.fetch(guildId).catch(() => null);

  if (!guild) {
    const error = new Error('NyxEclipse is not installed in this server.');
    error.statusCode = 404;
    throw error;
  }

  return { user: auth.user, oauthGuild, guild };
}

export async function getDashboardGuilds(client, accessToken) {
  const auth = await authenticateDashboardRequest(accessToken);
  return auth.guilds
    .filter((guild) => {
      const permissions = BigInt(guild.permissions || '0');
      return guild.owner === true ||
        (permissions & PermissionFlagsBits.ManageGuild) === PermissionFlagsBits.ManageGuild ||
        (permissions & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
    })
    .map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      owner: guild.owner === true,
      permissions: guild.permissions,
      botPresent: client.guilds.cache.has(guild.id),
    }));
}

export async function getDashboardGuild(client, accessToken, guildId) {
  const { guild } = await authorizeGuild(client, accessToken, guildId);
  const [config, counters, logging] = await Promise.all([
    getGuildConfig(client, guildId),
    getServerCounters(client, guildId),
    getLoggingStatus(client, guildId),
  ]);

  return {
    id: guild.id,
    name: guild.name,
    icon: guild.icon,
    ownerId: guild.ownerId,
    memberCount: guild.memberCount ?? guild.members.cache.size,
    botCount: guild.members.cache.filter((member) => member.user?.bot).size,
    humanCount: Math.max((guild.memberCount ?? guild.members.cache.size) - guild.members.cache.filter((member) => member.user?.bot).size, 0),
    channels: guild.channels.cache.size,
    roles: guild.roles.cache.size,
    config,
    counters,
    logging,
  };
}

export async function updateDashboardGuildConfig(client, accessToken, guildId, patch) {
  await authorizeGuild(client, accessToken, guildId);

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    const error = new Error('Configuration patch must be an object.');
    error.statusCode = 400;
    throw error;
  }

  return patchGuildConfig(client, guildId, patch, {
    source: 'GuildNexus Dashboard',
    actorId: (await authenticateDashboardRequest(accessToken)).user.id,
  });
}

export async function getDashboardCases(client, accessToken, guildId, filters = {}) {
  await authorizeGuild(client, accessToken, guildId);
  return getModerationCases(guildId, {
    userId: filters.userId,
    moderatorId: filters.moderatorId,
    action: filters.action,
    limit: Math.min(Math.max(Number(filters.limit) || 50, 1), 100),
    offset: Math.max(Number(filters.offset) || 0, 0),
  });
}

export async function getDashboardResources(client, accessToken, guildId) {
  const { guild } = await authorizeGuild(client, accessToken, guildId);

  const channels = await guild.channels.fetch();
  const roles = await guild.roles.fetch();

  return {
    channels: [...channels.values()]
      .filter((channel) => channel)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: channel.parentId ?? null,
      })),
    roles: [...roles.values()]
      .sort((a, b) => b.position - a.position)
      .map((role) => ({
        id: role.id,
        name: role.name,
        position: role.position,
        managed: role.managed,
        color: role.color,
      })),
  };
}

export async function getDashboardMember(client, accessToken, guildId, userId) {
  const { guild } = await authorizeGuild(client, accessToken, guildId);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    const error = new Error('Member not found in this server.');
    error.statusCode = 404;
    throw error;
  }

  const snowflake = BigInt(userId);
  const createdAt = new Date(Number((snowflake >> 22n) + 1420070400000n));

  return {
    id: member.id,
    username: member.user.username,
    globalName: member.user.globalName,
    avatar: member.user.displayAvatarURL({ size: 128 }),
    bot: member.user.bot,
    joinedAt: member.joinedAt,
    accountCreatedAt: createdAt.toISOString(),
    roles: member.roles.cache.filter((role) => role.id !== guild.id).map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color,
    })),
  };
}

export async function getDashboardAuditLog(client, accessToken, guildId, filters = {}) {
  const { guild } = await authorizeGuild(client, accessToken, guildId);
  const config = await getGuildConfig(client, guildId);
  const channelId = config?.logging?.channels?.audit ?? config?.logging?.channelId ?? null;
  if (!channelId) return { enabled: false, channel: null, events: [] };

  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return { enabled: false, channel: null, events: [] };

  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 100);
  const messages = await channel.messages.fetch({ limit });
  const events = [...messages.values()]
    .filter((message) => message.author?.id === client.user.id && message.embeds?.length)
    .map((message) => ({
      id: message.id,
      createdAt: message.createdAt,
      content: message.content || null,
      url: message.url,
      embed: {
        title: message.embeds[0]?.title || null,
        description: message.embeds[0]?.description || null,
        color: message.embeds[0]?.color || null,
        fields: message.embeds[0]?.fields || [],
        footer: message.embeds[0]?.footer?.text || null,
      },
    }));

  return {
    enabled: Boolean(config?.logging?.enabled),
    channel: { id: channel.id, name: channel.name },
    events,
  };
}

export async function updateDashboardLogging(client, accessToken, guildId, patch) {
  await authorizeGuild(client, accessToken, guildId);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    const error = new Error('Logging configuration must be an object.');
    error.statusCode = 400;
    throw error;
  }
  if (typeof patch.enabled === 'boolean') await setLoggingEnabled(client, guildId, patch.enabled);
  if (patch.channels && typeof patch.channels === 'object') {
    for (const destination of ['audit', 'applications', 'reports']) {
      if (destination in patch.channels) await setLogChannel(client, guildId, destination, patch.channels[destination] || null);
    }
  }
  if (patch.enabledEvents && typeof patch.enabledEvents === 'object') {
    const entries = Object.entries(patch.enabledEvents);
    for (const [eventType, enabled] of entries) {
      if (typeof enabled === 'boolean') await toggleEventLogging(client, guildId, eventType, enabled);
    }
  }
  return getLoggingStatus(client, guildId);
}
