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

  // Validate STEP_CA_ACME_URL if provided
  const stepCaAcmeUrl = process.env.STEP_CA_ACME_URL;
  if (stepCaAcmeUrl && !isValidUrl(stepCaAcmeUrl)) {
    errors.push(`STEP_CA_ACME_URL is not a valid URL: ${stepCaAcmeUrl}`);
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

/**
 * Detect production environment indicators.
 * If any are present, dev mode bypasses should be disabled even in development.
 */
function detectProductionIndicators(): string[] {
  const indicators: string[] = [];

  // Kubernetes
  if (process.env.KUBERNETES_SERVICE_HOST || process.env.K8S_NAMESPACE) {
    indicators.push('Kubernetes environment detected');
  }

  // AWS
  if (process.env.AWS_EXECUTION_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.ECS_CONTAINER_METADATA_URI) {
    indicators.push('AWS environment detected');
  }

  // GCP
  if (process.env.GOOGLE_CLOUD_PROJECT || process.env.K_SERVICE || process.env.CLOUD_RUN_JOB) {
    indicators.push('GCP environment detected');
  }

  // Azure
  if (process.env.WEBSITE_SITE_NAME || process.env.AZURE_FUNCTIONS_ENVIRONMENT) {
    indicators.push('Azure environment detected');
  }

  // Let's Encrypt / public domain (indicates production deployment)
  if (process.env.ACME_EMAIL || process.env.LETSENCRYPT_EMAIL) {
    indicators.push('Let\'s Encrypt configuration detected');
  }

  // Systemd service
  if (process.env.INVOCATION_ID && process.env.JOURNAL_STREAM) {
    indicators.push('Running as systemd service');
  }

  return indicators;
}

const productionIndicators = detectProductionIndicators();

// Default values
const DEFAULT_PORT = 3001;
const DEFAULT_BCRYPT_ROUNDS = 12;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_REQUESTS = 1000; // Generous limit for single-user admin UI
const AUTH_RATE_LIMIT_MAX = 20; // Stricter limit for auth endpoints

export interface JwtSecretResult {
  secret: string;
  isEphemeral: boolean;
  debugHint?: string;
}

/**
 * Get JWT secret - generates ephemeral secret for dev mode, requires env var for production
 */
function getJwtSecret(): JwtSecretResult {
  const envSecret = process.env.JWT_SECRET;

  if (envSecret) {
    return {
      secret: envSecret,
      isEphemeral: false,
    };
  }

  if (isDevelopment) {
    // Generate random ephemeral secret for development
    const ephemeralSecret = randomBytes(32).toString('base64');
    return {
      secret: ephemeralSecret,
      isEphemeral: true,
      // First 8 chars for debugging (enough to identify without exposing full secret)
      debugHint: ephemeralSecret.substring(0, 8) + '...',
    };
  }

  // In production, JWT_SECRET is required
  throw new Error(
    'JWT_SECRET environment variable is required in production. ' +
    'Generate one with: openssl rand -base64 32'
  );
}

const jwtSecretResult = getJwtSecret();

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

  stepCa: {
    // ACME directory URL for step-ca (configurable for custom deployments)
    acmeUrl: process.env.STEP_CA_ACME_URL || 'https://ca.ownprem.local:8443/acme/acme/directory',
    // Path to step-ca root CA certificate
    rootCertPath: process.env.STEP_CA_ROOT_CERT || '/etc/step-ca/root_ca.crt',
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
    secret: jwtSecretResult.secret,
    isEphemeral: jwtSecretResult.isEphemeral,
    debugHint: jwtSecretResult.debugHint,
    accessTokenExpiry: '15m',
    refreshTokenExpiry: '7d',
  },

  cookies: {
    // Cookie security settings
    secure: !isDevelopment, // Require HTTPS in production
    sameSite: 'strict' as const,
    httpOnly: true,
    // Access token cookie (short-lived)
    accessTokenMaxAge: 15 * 60 * 1000, // 15 minutes in ms
    // Refresh token cookie (longer-lived, restricted path)
    refreshTokenMaxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    refreshTokenPath: '/api/auth', // Restrict refresh token to auth endpoints
  },

  security: {
    bcryptRounds: DEFAULT_BCRYPT_ROUNDS,
    rateLimitWindow: RATE_LIMIT_WINDOW_MS,
    rateLimitMax: RATE_LIMIT_MAX_REQUESTS,
    authRateLimitMax: AUTH_RATE_LIMIT_MAX,
    // Login lockout after failed attempts (1 hour window, 5 attempts)
    loginLockoutWindow: 60 * 60 * 1000,
    loginLockoutMax: 5,
  },

  csp: {
    // Additional CSP connect-src origins (e.g., external APIs)
    additionalConnectSrc: process.env.CSP_CONNECT_SRC?.split(',').filter(Boolean) || [],
    // Report-only mode for testing CSP without breaking functionality
    reportOnly: process.env.CSP_REPORT_ONLY === 'true',
    // CSP report URI for violation reporting
    reportUri: process.env.CSP_REPORT_URI || null,
  },

  cors: {
    origin: process.env.CORS_ORIGIN || (isDevelopment ? '*' : ''),
  },

  devMode: {
    /**
     * Whether dev auth bypass is allowed.
     * Only enabled when:
     * 1. NODE_ENV=development
     * 2. ALLOW_DEV_AUTH_BYPASS=true is set
     * 3. No production indicators are detected
     */
    bypassAuth: isDevelopment &&
      process.env.ALLOW_DEV_AUTH_BYPASS === 'true' &&
      productionIndicators.length === 0,
    productionIndicators,
  },
};

// Validate environment configuration at module load
validateEnvConfig(isDevelopment);

export type Config = typeof config;
