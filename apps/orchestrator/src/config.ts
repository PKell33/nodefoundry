import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const nodeEnv = process.env.NODE_ENV;
if (!nodeEnv) {
  console.warn('WARNING: NODE_ENV not set - defaulting to production mode for safety');
}
const isDevelopment = nodeEnv === 'development';

// Default values
const DEFAULT_PORT = 3001;
const DEFAULT_BCRYPT_ROUNDS = 12;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_REQUESTS = 100;
const AUTH_RATE_LIMIT_MAX = 10; // Stricter limit for auth endpoints

/**
 * Get JWT secret - generates ephemeral secret for dev mode, requires env var for production
 */
function getJwtSecret(): string {
  const envSecret = process.env.JWT_SECRET;

  if (envSecret) {
    return envSecret;
  }

  if (isDevelopment) {
    // Generate random ephemeral secret for development
    // This is logged at startup so developers know sessions won't persist
    return randomBytes(32).toString('base64');
  }

  // In production, JWT_SECRET is required
  throw new Error(
    'JWT_SECRET environment variable is required in production. ' +
    'Generate one with: openssl rand -base64 32'
  );
}

export const config = {
  port: parseInt(process.env.PORT || String(DEFAULT_PORT), 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment,

  database: {
    path: process.env.DATABASE_PATH || join(__dirname, '../../../data/ownprem.sqlite'),
  },

  paths: {
    data: process.env.DATA_PATH || join(__dirname, '../../../data'),
    apps: process.env.APPS_PATH || join(__dirname, '../../../data/apps'),
    appDefinitions: process.env.APP_DEFINITIONS_PATH || join(__dirname, '../../../app-definitions'),
    logs: process.env.LOGS_PATH || join(__dirname, '../../../logs'),
    backups: process.env.BACKUP_PATH || join(__dirname, '../../../data/backups'),
    caddyConfig: process.env.CADDY_CONFIG_PATH || '/etc/caddy/Caddyfile',
  },

  caddy: {
    domain: process.env.CADDY_DOMAIN || 'ownprem.local',
    adminUrl: process.env.CADDY_ADMIN_URL || 'http://localhost:2019',
    devUiPort: parseInt(process.env.DEV_UI_PORT || '5173', 10),
    uiDistPath: process.env.UI_DIST_PATH || (isDevelopment
      ? join(__dirname, '../../../apps/ui/dist')
      : '/opt/ownprem/repo/apps/ui/dist'),
  },

  secrets: {
    key: process.env.SECRETS_KEY || '',
  },

  jwt: {
    secret: getJwtSecret(),
    accessTokenExpiry: '15m',
    refreshTokenExpiry: '7d',
  },

  security: {
    bcryptRounds: DEFAULT_BCRYPT_ROUNDS,
    rateLimitWindow: RATE_LIMIT_WINDOW_MS,
    rateLimitMax: RATE_LIMIT_MAX_REQUESTS,
    authRateLimitMax: AUTH_RATE_LIMIT_MAX,
  },

  cors: {
    origin: process.env.CORS_ORIGIN || (isDevelopment ? '*' : ''),
  },
};

export type Config = typeof config;
