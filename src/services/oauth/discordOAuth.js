import crypto from 'crypto';

const DISCORD_API = 'https://discord.com/api/v10';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';

const stateStore = new Map();
const sessionStore = new Map();

const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required OAuth environment variable: ${name}`);
  }
  return value;
}

export function getOAuthConfig() {
  return {
    clientId: required('CLIENT_ID'),
    clientSecret: required('DISCORD_CLIENT_SECRET'),
    redirectUri: required('DISCORD_REDIRECT_URI'),
    dashboardUrl: required('GUILDNEXUS_DASHBOARD_URL'),
  };
}

function cleanup() {
  const now = Date.now();

  for (const [key, value] of stateStore) {
    if (value.expiresAt <= now) stateStore.delete(key);
  }

  for (const [key, value] of sessionStore) {
    if (value.expiresAt <= now) sessionStore.delete(key);
  }
}

function createToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function createDiscordAuthorizationUrl() {
  cleanup();

  const config = getOAuthConfig();
  const state = createToken(32);

  stateStore.set(state, {
    expiresAt: Date.now() + STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'consent',
  });

  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function consumeState(state) {
  const entry = stateStore.get(state);
  stateStore.delete(state);

  if (!entry || entry.expiresAt <= Date.now()) {
    return false;
  }

  return true;
}

async function exchangeCode(code) {
  const config = getOAuthConfig();

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Discord OAuth token exchange failed (${response.status}): ${detail}`);
  }

  return response.json();
}

async function discordRequest(path, accessToken) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'NyxEclipse/2.1 GuildNexus',
    },
  });

  if (!response.ok) {
    throw new Error(`Discord API request failed (${response.status})`);
  }

  return response.json();
}

export async function completeDiscordCallback({ code, state }) {
  cleanup();

  if (!consumeState(state)) {
    const error = new Error('Invalid or expired OAuth state.');
    error.statusCode = 400;
    throw error;
  }

  const tokens = await exchangeCode(code);
  const user = await discordRequest('/users/@me', tokens.access_token);

  const sessionToken = createToken(32);

  sessionStore.set(sessionToken, {
    user,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  return {
    sessionToken,
    user,
  };
}

export function getDiscordSession(sessionToken) {
  cleanup();

  if (!sessionToken) return null;

  const session = sessionStore.get(sessionToken);
  if (!session || session.expiresAt <= Date.now()) {
    sessionStore.delete(sessionToken);
    return null;
  }

  return session;
}

export function destroyDiscordSession(sessionToken) {
  sessionStore.delete(sessionToken);
}

export async function getUserGuilds(sessionToken) {
  const session = getDiscordSession(sessionToken);
  if (!session) {
    const error = new Error('Invalid or expired dashboard session.');
    error.statusCode = 401;
    throw error;
  }

  return discordRequest('/users/@me/guilds', session.accessToken);
}

export function getDashboardCallbackUrl(sessionToken) {
  const { dashboardUrl } = getOAuthConfig();
  const url = new URL('/pages/invite', dashboardUrl);
  url.searchParams.set('session', sessionToken);
  return url.toString();
}
