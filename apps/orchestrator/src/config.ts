import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Validates that a string is a valid URL
 */
function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates that a port number is in valid range (1-65535)
 */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Validates environment variable configuration at startup.
 * Throws an error if critical configuration is invalid.
 */
function validateEnvConfig(isDev: boolean): void {
  const errors: string[] = [];

  // Validate CADDY_ADMIN_URL if provided
  const caddyAdminUrl = process.env.CADDY_ADMIN_URL;
  if (caddyAdminUrl && !isValidUrl(caddyAdminUrl)) {
    errors.push(`CADDY_ADMIN_URL is not a valid URL: ${caddyAdminUrl}`);
  }

  // Validate PORT if provided
  const port = process.env.PORT;
  if (port) {
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || !isValidPort(portNum)) {
      errors.push(`PORT must be a valid port number (1-65535): ${port}`);
    }
  }

  // Validate DEV_UI_PORT if provided
  const devUiPort = process.env.DEV_UI_PORT;
  if (devUiPort) {
    const portNum = parseInt(devUiPort, 10);
    if (isNaN(portNum) || !isValidPort(portNum)) {
      errors.push(`DEV_UI_PORT must be a valid port number (1-65535): ${devUiPort}`);
    }
  }

  // Validate CORS_ORIGIN if provided (should be a valid URL or '*')
  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin && corsOrigin !== '*' && !isValidUrl(corsOrigin)) {
    errors.push(`CORS_ORIGIN must be a valid URL or '*': ${corsOrigin}`);
  }

  // In production, certain env vars are required
  if (!isDev) {
    if (!process.env.JWT_SECRET) {
      // This is handled separately in getJwtSecret(), but we note it here for completeness
    }
    if (!process.env.SECRETS_KEY) {
      errors.push('SECRETS_KEY is required in production for encrypting secrets');
    }
  }

  if (errors.length > 0) {
    throw new Error(
      'Invalid environment configuration:\n  - ' + errors.join('\n  - ')
    );
  }
}

const nodeEnv = process.env.NODE_ENV;
if (!nodeEnv) {
  // Using process.stderr.write for early startup warning (before logger is available)
  process.stderr.write('WARNING: NODE_ENV not set - defaulting to production mode for safety\n');
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

  tokens: {
    // HMAC key for agent token hashing - provides protection even if DB is leaked
    // Uses SECRETS_KEY as base, or generates ephemeral key in development
    hmacKey: process.env.SECRETS_KEY || (isDevelopment ? randomBytes(32).toString('base64') : ''),
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

// Validate environment configuration at module load
validateEnvConfig(isDevelopment);

export type Config = typeof config;
