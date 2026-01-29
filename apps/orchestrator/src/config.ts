import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isDevelopment = (process.env.NODE_ENV || 'development') === 'development';

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
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
    caddyConfig: process.env.CADDY_CONFIG_PATH || (isDevelopment ? join(__dirname, '../../../caddy/Caddyfile') : '/etc/caddy/Caddyfile'),
  },

  caddy: {
    domain: process.env.CADDY_DOMAIN || 'ownprem.local',
    reloadCommand: process.env.CADDY_RELOAD_CMD || (isDevelopment ? '' : 'systemctl reload caddy'),
  },

  secrets: {
    key: process.env.SECRETS_KEY || '',
  },

  jwt: {
    secret: process.env.JWT_SECRET || (isDevelopment ? 'dev-jwt-secret-change-in-production' : ''),
    accessTokenExpiry: '15m',
    refreshTokenExpiry: '7d',
  },

  security: {
    bcryptRounds: 12,
    rateLimitWindow: 15 * 60 * 1000, // 15 minutes
    rateLimitMax: 100, // requests per window
  },

  cors: {
    origin: process.env.CORS_ORIGIN || (isDevelopment ? '*' : ''),
  },
};

export type Config = typeof config;
