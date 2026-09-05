import 'dotenv/config';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import cron from 'node-cron';

import config from './config/application.js';
import { initializeDatabase } from './utils/database.js';
import { getGuildConfig } from './services/config/guildConfig.js';
import {
  getDashboardGuilds,
  getDashboardGuild,
  updateDashboardGuildConfig,
  getDashboardCases,
  getDashboardResources,
  getDashboardMember,
  getDashboardAuditLog,
  updateDashboardLogging,
  authenticateDashboardRequest,
  createDashboardOAuthState,
  consumeDashboardOAuthState,
  exchangeDashboardOAuthCode,
  getDashboardSession,
  getSessionFromRequest,
  destroyDashboardSession,
} from './services/dashboardApiService.js';
import { getServerCounters, saveServerCounters, updateCounter } from './services/serverstatsService.js';
import { logger, startupLog, shutdownLog } from './utils/logger.js';
import { checkBirthdays } from './services/birthdayService.js';
import { checkGiveaways } from './services/giveawayService.js';
import { loadCommands, registerCommands as registerSlashCommands } from './handlers/loaders/commandLoader.js';
import { runSafeTask, handleTaskError, ErrorCodes } from './utils/errorHandler.js';
import { initializeMusic } from './services/music/riffySetup.js';
import { shutdownMusic } from './services/music/playerHandler.js';
import pkg from '../package.json' with { type: 'json' };
import { EXPECTED_SCHEMA_VERSION, EXPECTED_SCHEMA_LABEL } from './config/database/schemaVersion.js';

class NyxEclypse extends Client {
  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildBans,
      ],
    });

    this.config = config;
    this.commands = new Collection();
    this.events = new Collection();
    this.buttons = new Collection();
    this.selectMenus = new Collection();
    this.modals = new Collection();
    this.cooldowns = new Collection();
    this.db = null;
    this.rest = new REST({ version: '10' }).setToken(config.bot.token);
  }

  async start() {
    try {
      startupLog('Starting NyxEclypse...');
      await new Promise(resolve => setTimeout(resolve, 1000));

      startupLog('Initializing database...');
      const dbInstance = await initializeDatabase();
      this.db = dbInstance.db;

      const dbStatus = this.db.getStatus();
      if (dbStatus.isDegraded) {
        logger.warn('');
        logger.warn('╔═══════════════════════════════════════════════════════╗');
        logger.warn('║ ⚠️  DATABASE RUNNING IN DEGRADED MODE                 ║');
        logger.warn('║                                                       ║');
        logger.warn('║ Connection: In-Memory Storage (PostgreSQL unavailable)║');
        logger.warn('║ Data Persistence: DISABLED - data lost on restart    ║');
        logger.warn('║ Action Required: Fix PostgreSQL and restart bot      ║');
        logger.warn('╚═══════════════════════════════════════════════════════╝');
        logger.warn('');
      } else {
        startupLog(`✅ Database Status: ${dbStatus.connectionType} (fully operational)`);
      }

      startupLog('Starting web server...');
      this.startWebServer();

      startupLog('Loading commands...');
      await loadCommands(this);
      startupLog(`Commands loaded: ${this.commands.size}`);

      startupLog('Loading handlers...');
      await this.loadHandlers();
      startupLog('Handlers loaded');

      initializeMusic(this);

      startupLog('Logging into Discord...');
      await this.login(this.config.bot.token);
      startupLog('Discord login successful');

      startupLog('Registering slash commands globally...');
      await this.registerCommands();
      startupLog('Slash commands registration complete');

      const databaseMode = dbStatus.isDegraded
        ? 'Optional in-memory mode (data resets after restart)'
        : 'Connected (persistent data enabled)';
      const handlerSummary = `${this.buttons.size} buttons, ${this.selectMenus.size} menus, ${this.modals.size} modals`;
      startupLog(
        `ONLINE ✅ | ${this.commands.size} commands loaded | ${handlerSummary} | Database: ${databaseMode}`
      );

      this.setupCronJobs();
    } catch (error) {
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  startWebServer() {
    const app = express();
    const client = this;
    const configuredPort = Number(this.config.api?.port || process.env.PORT || 26116);
    const maxPortRetryAttempts = Number(process.env.PORT_RETRY_ATTEMPTS || 5);
    const host = process.env.WEB_HOST || '0.0.0.0';
    const corsOrigin = this.config.api?.cors?.origin || '*';

    app.use((req, res, next) => {
      const allowedOrigins = Array.isArray(corsOrigin) ? corsOrigin : [corsOrigin];
      const origin = req.headers.origin;

      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
        res.header('Access-Control-Allow-Credentials', 'true');
      }
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    const requestCounts = new Map();
    const windowMs = this.config.api?.rateLimit?.windowMs || 60000;
    const maxRequests = this.config.api?.rateLimit?.max || 100;

    app.use((req, res, next) => {
      const ip = req.ip;
      const now = Date.now();
      const windowStart = now - windowMs;

      if (!requestCounts.has(ip)) {
        requestCounts.set(ip, []);
      }

      const times = requestCounts.get(ip).filter(t => t > windowStart);

      if (times.length >= maxRequests) {
        return res.status(429).json({ error: 'Too many requests' });
      }

      times.push(now);
      requestCounts.set(ip, times);
      next();
    });

    const getBearerToken = (req) => {
      const auth = req.headers.authorization || '';
      return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    };

    const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || 'https://guildnexus.brittanyburwell19.workers.dev';
    const DASHBOARD_INVITE_PAGE = process.env.DASHBOARD_INVITE_PAGE || `${DASHBOARD_ORIGIN}/pages/invite`;
    const DASHBOARD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || process.env.DASHBOARD_OAUTH_REDIRECT_URI || `${DASHBOARD_ORIGIN}/api/auth/discord/callback`;

    app.get('/api/auth/discord', (req, res) => {
      const state = createDashboardOAuthState();
      const params = new URLSearchParams({
        client_id: process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID,
        response_type: 'code',
        redirect_uri: DASHBOARD_REDIRECT_URI,
        scope: 'identify guilds',
        state,
      });
      res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
    });

    app.get('/api/auth/discord/callback', async (req, res) => {
      try {
        if (!consumeDashboardOAuthState(req.query.state)) {
          return res.status(400).send('Invalid or expired OAuth state.');
        }

        const sessionId = await exchangeDashboardOAuthCode(req.query.code, DASHBOARD_REDIRECT_URI);
        res.cookie?.('gn_session', sessionId, {
          httpOnly: true,
          secure: true,
          sameSite: 'none',
          maxAge: 7 * 24 * 60 * 60 * 1000,
          path: '/',
        });
        if (!res.headersSent) {
          res.setHeader('Set-Cookie', `gn_session=${encodeURIComponent(sessionId)}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=None`);
        }

        // Browser-side OAuth handling reads this redirect's fragment so the
        // session identifier never appears in the HTTP request URL.
        res.redirect(`${DASHBOARD_INVITE_PAGE}#session=${encodeURIComponent(sessionId)}`);
      } catch (error) {
        res.status(error.statusCode || 500).send(error.message || 'Discord OAuth failed.');
      }
    });

    app.get('/api/auth/session', (req, res) => {
      try {
        const bearer = getBearerToken(req);
        const session = getDashboardSession(bearer || getSessionFromRequest(req));
        res.json({ user: session.user, authenticated: true });
      } catch (error) {
        res.status(error.statusCode || 401).json({ error: error.message });
      }
    });

    app.post('/api/auth/logout', (req, res) => {
      destroyDashboardSession(getSessionFromRequest(req));
      res.setHeader('Set-Cookie', 'gn_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None');
      res.json({ ok: true });
    });

    const dashboardAuth = async (req, res, next) => {
      try {
        const bearer = getBearerToken(req);
        const sessionId = bearer || getSessionFromRequest(req);
        let session = null;
        try {
          session = getDashboardSession(sessionId);
        } catch {
          session = null;
        }

        if (session) {
          req.dashboardSession = session;
          req.dashboardToken = session.accessToken;
          req.dashboardAuth = {
            user: session.user,
            guilds: session.guilds,
            expiresAt: session.expiresAt,
          };
        } else {
          req.dashboardToken = bearer;
          req.dashboardAuth = await authenticateDashboardRequest(req.dashboardToken);
        }
        next();
      } catch (error) {
        res.status(error.statusCode || 401).json({ error: error.message || 'Dashboard authentication failed.' });
      }
    };

    app.get('/api/dashboard/me', dashboardAuth, (req, res) => {
      res.json({ user: req.dashboardAuth.user });
    });

    app.get('/api/dashboard/guilds', dashboardAuth, async (req, res) => {
      try {
        res.json({ guilds: await getDashboardGuilds(client, req.dashboardToken) });
      } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message || 'Failed to load servers.' });
      }
    });

    app.get('/api/dashboard/guilds/:guildId', dashboardAuth, async (req, res) => {
      try {
        res.json({ guild: await getDashboardGuild(client, req.dashboardToken, req.params.guildId) });
      } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message || 'Failed to load server.' });
      }
    });

    app.patch('/api/dashboard/guilds/:guildId/config', dashboardAuth, express.json({ limit: '64kb' }), async (req, res) => {
      try {
        const config = await updateDashboardGuildConfig(client, req.dashboardToken, req.params.guildId, req.body);
        res.json({ config });
      } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message || 'Failed to save server configuration.' });
      }
    });

    app.get('/api/dashboard/guilds/:guildId/cases', dashboardAuth, async (req, res) => {
      try {
        res.json({ cases: await getDashboardCases(client, req.dashboardToken, req.params.guildId, req.query) });
      } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message || 'Failed to load moderation cases.' });
      }
    });

    app.get('/api/dashboard/guilds/:guildId/audit-log', dashboardAuth, async (req, res) => {
      try { res.json(await getDashboardAuditLog(client, req.dashboardToken, req.params.guildId, req.query)); }
      catch (error) { res.status(error.statusCode || 500).json({ error: error.message || 'Failed to load audit log.' }); }
    });

    app.patch('/api/dashboard/guilds/:guildId/logging', dashboardAuth, express.json({ limit: '64kb' }), async (req, res) => {
      try { res.json({ logging: await updateDashboardLogging(client, req.dashboardToken, req.params.guildId, req.body) }); }
      catch (error) { res.status(error.statusCode || 500).json({ error: error.message || 'Failed to update logging.' }); }
    });

    app.get('/api/dashboard/guilds/:guildId/members/:userId', dashboardAuth, async (req, res) => {
      try {
        res.json({ member: await getDashboardMember(client, req.dashboardToken, req.params.guildId, req.params.userId) });
      } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message || 'Failed to load member.' });
      }
    });

    app.get('/api/dashboard/guilds/:guildId/resources', dashboardAuth, async (req, res) => {
      try {
        res.json(await getDashboardResources(client, req.dashboardToken, req.params.guildId));
      } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message || 'Failed to load server resources.' });
      }
    });

    app.get('/health', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: 'unknown' };
      const status = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          connected: dbStatus.connectionType !== 'none',
          degraded: dbStatus.isDegraded,
          type: dbStatus.connectionType
        }
      };
      res.status(200).json(status);
    });

    app.get('/ready', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: true, connectionType: 'none' };
      const isReady = this.isReady() && !dbStatus.isDegraded;

      const metrics = {
        guildCount: this.guilds?.cache?.size ?? 0,
        commandCount: this.commands?.size ?? 0,
        database: {
          mode: dbStatus.connectionType,
          degraded: dbStatus.isDegraded,
          degradedReason: dbStatus.degradedReason ?? null,
        },
        schemaVersion: EXPECTED_SCHEMA_VERSION,
        schemaLabel: EXPECTED_SCHEMA_LABEL,
      };

      if (isReady) {
        return res.status(200).json({
          ready: true,
          message: 'Bot is ready',
          metrics,
        });
      }

      res.status(503).json({
        ready: false,
        reason: !this.isReady() ? 'Bot not Ready' : 'Database degraded',
        metrics,
      });
    });

    app.get('/', (req, res) => {
      res.status(200).json({
        message: 'NyxEclypse System Online',
        version: pkg.version,
        timestamp: new Date().toISOString()
      });
    });

    const startServer = (port, attempt = 0) => {
      let hasStartedListening = false;
      const server = app.listen(port, host, () => {
        hasStartedListening = true;
        this.webServer = server;
        startupLog(`✅ Web Server running on ${host}:${port}`);
        startupLog(`Health endpoint: http://${host}:${port}/health`);
        startupLog(`Ready endpoint: http://${host}:${port}/ready`);
      });

      server.on('error', (error) => {
        const errorCode = error?.code || 'UNKNOWN';
        if (errorCode === 'EADDRINUSE' && attempt < maxPortRetryAttempts) {
          const nextPort = port + 1;
          logger.warn(`Port ${port} is already in use. Retrying on ${nextPort} (${attempt + 1}/${maxPortRetryAttempts}).`);
          server.close(() => startServer(nextPort, attempt + 1));
          return;
        }
        if (!hasStartedListening) {
          logger.error(`Web server failed to start on ${host}:${port}:`, error);
          return;
        }
        logger.error('Web server error:', error);
      });
    };

    startServer(configuredPort);
  }

  async loadHandlers() {
    const { loadEventHandlers } = await import('./handlers/eventHandler.js');
    await loadEventHandlers(this);
  }

  async registerCommands() {
    await registerSlashCommands(this);
  }

  setupCronJobs() {
    cron.schedule('0 0 * * *', () => runSafeTask('birthday-check', () => checkBirthdays(this), handleTaskError));
    cron.schedule('*/5 * * * *', () => runSafeTask('giveaway-check', () => checkGiveaways(this), handleTaskError));
  }

  async shutdown() {
    try {
      shutdownLog('Shutting down NyxEclypse...');
      shutdownMusic(this);
      if (this.webServer) {
        await new Promise(resolve => this.webServer.close(resolve));
      }
      this.destroy();
      shutdownLog('NyxEclypse shutdown complete');
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
  }
}

const client = new NyxEclypse();

process.on('SIGINT', async () => {
  await client.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await client.shutdown();
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
});

client.start();
