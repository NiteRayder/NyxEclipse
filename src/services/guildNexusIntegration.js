import { getGuildConfig } from './config/guildConfig.js';

/**
 * GuildNexus integration helpers.
 *
 * GuildNexus is a control panel for NyxEclipse, so the bot remains the
 * authoritative source for live Discord state and guild configuration.
 * The dashboard reads this information through the existing dashboard API
 * instead of the bot making a circular HTTP request back through Cloudflare.
 */
export async function getGuildNexusConfig(client, guildId) {
  return getGuildConfig(client, guildId);
}

export function getGuildNexusTelemetry(client) {
  const guilds = client.guilds?.cache;
  const users = client.users?.cache;
  const commands = client.commands;
  const dbStatus = client.db?.getStatus?.() || {
    connectionType: 'none',
    isDegraded: true,
    degradedReason: 'Database status unavailable',
  };

  return {
    status: client.isReady?.() ? 'online' : 'offline',
    pingMs: client.ws?.ping ?? null,
    guildCount: guilds?.size ?? 0,
    cachedUserCount: users?.size ?? 0,
    commandCount: commands?.size ?? 0,
    uptimeMs: Math.round(process.uptime() * 1000),
    database: {
      mode: dbStatus.connectionType ?? 'none',
      degraded: Boolean(dbStatus.isDegraded),
      degradedReason: dbStatus.degradedReason ?? null,
    },
    timestamp: new Date().toISOString(),
  };
}

export function getGuildNexusGuildSnapshot(client, guild) {
  const botCount = guild.members?.cache?.filter((member) => member.user?.bot).size ?? 0;
  const memberCount = guild.memberCount ?? guild.members?.cache?.size ?? 0;

  return {
    id: guild.id,
    name: guild.name,
    icon: guild.icon,
    memberCount,
    botCount,
    humanCount: Math.max(memberCount - botCount, 0),
    channels: guild.channels?.cache?.size ?? 0,
    roles: guild.roles?.cache?.size ?? 0,
  };
}
