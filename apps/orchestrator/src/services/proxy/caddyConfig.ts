/**
 * Caddy configuration generation and Admin API communication.
 * Handles generating Caddy JSON config and pushing it via the Admin API.
 */

import { createHash } from 'crypto';
import { config } from '../../config.js';
import { withRetry, isNetworkError, isRetryableStatus } from '../../lib/retry.js';
import logger from '../../lib/logger.js';
import type { ProxyRoute, ServiceRoute } from './proxyTypes.js';

interface CaddyManagerState {
  lastConfigHash: string | null;
  lastGoodConfig: object | null;
  consecutiveFailures: number;
}

const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Create initial Caddy manager state.
 */
export function createCaddyState(): CaddyManagerState {
  return {
    lastConfigHash: null,
    lastGoodConfig: null,
    consecutiveFailures: 0,
  };
}

/**
 * Check if step-ca is running and accessible.
 */
export async function isStepCaAvailable(): Promise<boolean> {
  try {
    // Check if the root CA cert exists (indicates step-ca is installed)
    const { access } = await import('fs/promises');
    await access('/etc/step-ca/root_ca.crt');

    // Try to reach the ACME directory endpoint using https module for self-signed cert support
    const https = await import('https');
    const result = await new Promise<boolean>((resolve) => {
      const req = https.request({
        hostname: '127.0.0.1',
        port: 8443,
        path: '/acme/acme/directory',
        method: 'GET',
        rejectUnauthorized: false,
        timeout: 2000,
      }, (res) => {
        resolve(res.statusCode === 200);
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.end();
    });

    if (result) {
      logger.debug('step-ca ACME endpoint is accessible');
      return true;
    }
  } catch {
    // step-ca not available
  }

  return false;
}

/**
 * Generate TLS configuration for Caddy.
 * Uses ACME issuer pointing to step-ca when available, falls back to internal CA.
 */
export async function generateTlsConfig(domain: string): Promise<object> {
  const stepCaAvailable = await isStepCaAvailable();

  if (stepCaAvailable) {
    const acmeDirectoryUrl = 'https://ca.ownprem.local:8443/acme/acme/directory';

    logger.info({ acmeDirectoryUrl }, 'Using step-ca ACME issuer for TLS');

    return {
      tls: {
        automation: {
          policies: [{
            subjects: [domain],
            issuers: [{
              module: 'acme',
              ca: acmeDirectoryUrl,
              trusted_roots_pem_files: ['/etc/step-ca/root_ca.crt'],
            }],
          }],
        },
      },
    };
  }

  // Fallback to Caddy's internal CA
  logger.info('step-ca not available, using Caddy internal CA for TLS');
  return {
    tls: {
      automation: {
        policies: [{
          subjects: [domain],
          issuers: [{ module: 'internal' }],
        }],
      },
    },
    pki: {
      certificate_authorities: {
        local: { install_trust: true },
      },
    },
  };
}

/**
 * Generate Caddy JSON configuration for the Admin API.
 */
export async function generateCaddyJsonConfig(
  routes: ProxyRoute[],
  serviceRoutes: ServiceRoute[],
  apiPort: number,
  domain: string
): Promise<object> {
  const httpRoutes = serviceRoutes.filter(r => r.routeType === 'http');
  const devUiPort = config.caddy.devUiPort;
  const tlsConfig = await generateTlsConfig(domain);

  // Build subroute handlers (routes within the host matcher)
  const subroutes: object[] = [];

  // API routes
  subroutes.push({
    match: [{ path: ['/api/*'] }],
    handle: [{
      handler: 'reverse_proxy',
      upstreams: [{ dial: `localhost:${apiPort}` }],
    }],
  });

  // WebSocket routes
  subroutes.push({
    match: [{ path: ['/socket.io/*'] }],
    handle: [{
      handler: 'reverse_proxy',
      upstreams: [{ dial: `localhost:${apiPort}` }],
    }],
  });

  // Health endpoints
  subroutes.push({
    match: [{ path: ['/health', '/ready'] }],
    handle: [{
      handler: 'reverse_proxy',
      upstreams: [{ dial: `localhost:${apiPort}` }],
    }],
  });

  // App Web UI routes (with path stripping)
  for (const route of routes) {
    subroutes.push({
      match: [{ path: [`${route.path}*`] }],
      handle: [
        {
          handler: 'rewrite',
          strip_path_prefix: route.path,
        },
        {
          handler: 'reverse_proxy',
          upstreams: [{ dial: route.upstream.replace('http://', '') }],
        },
      ],
    });
  }

  // HTTP service routes (with path stripping)
  for (const route of httpRoutes) {
    subroutes.push({
      match: [{ path: [`${route.externalPath}*`] }],
      handle: [
        {
          handler: 'rewrite',
          strip_path_prefix: route.externalPath,
        },
        {
          handler: 'reverse_proxy',
          upstreams: [{ dial: `${route.upstreamHost}:${route.upstreamPort}` }],
        },
      ],
    });
  }

  // Fallback to Vite dev server (development) or static files (production)
  if (config.isDevelopment) {
    subroutes.push({
      handle: [{
        handler: 'reverse_proxy',
        upstreams: [{ dial: `localhost:${devUiPort}` }],
      }],
    });
  } else {
    // Production: serve static UI files with SPA routing
    const uiDistPath = config.caddy.uiDistPath || '/opt/ownprem/ui/dist';
    subroutes.push({
      handle: [
        {
          handler: 'rewrite',
          uri: '{http.matchers.file.relative}',
        },
        {
          handler: 'file_server',
          root: uiDistPath,
        },
      ],
      match: [{
        file: {
          root: uiDistPath,
          try_files: ['{http.request.uri.path}', '/index.html'],
        },
      }],
    });
  }

  // Wrap subroutes in a host-matched route
  return {
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [':443'],
            routes: [{
              match: [{ host: [domain] }],
              handle: [{
                handler: 'subroute',
                routes: subroutes,
              }],
              terminal: true,
            }],
            tls_connection_policies: [{}],
          },
        },
      },
      ...tlsConfig,
    },
  };
}

/**
 * Attempt to restore the last known good Caddy configuration.
 */
async function restoreLastGoodConfig(
  caddyAdminUrl: string,
  state: CaddyManagerState
): Promise<boolean> {
  if (!state.lastGoodConfig) {
    logger.warn('No last known good config to restore');
    return false;
  }

  try {
    const response = await fetch(`${caddyAdminUrl}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.lastGoodConfig),
    });

    if (response.ok) {
      // Restore the hash to match
      const configJson = JSON.stringify(state.lastGoodConfig);
      state.lastConfigHash = createHash('sha256').update(configJson).digest('hex');
      return true;
    }

    logger.error({ status: response.status }, 'Failed to restore last good config');
    return false;
  } catch (err) {
    logger.error({ err }, 'Error restoring last good config');
    return false;
  }
}

/**
 * Push configuration to Caddy via Admin API.
 * Returns true if successful, false otherwise.
 */
export async function pushConfigToCaddy(
  caddyConfig: object,
  caddyAdminUrl: string,
  state: CaddyManagerState
): Promise<boolean> {
  // Compute hash of the config to avoid unnecessary reloads
  const configJson = JSON.stringify(caddyConfig);
  const configHash = createHash('sha256').update(configJson).digest('hex');

  // Skip reload if config hasn't changed
  if (state.lastConfigHash === configHash) {
    logger.info('Caddy config unchanged, skipping reload');
    return true;
  }

  // Circuit breaker: if we've had too many consecutive failures, skip this update
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    logger.warn({
      consecutiveFailures: state.consecutiveFailures,
    }, 'Caddy config update skipped - too many consecutive failures. Call resetCaddyState() to retry.');
    return false;
  }

  try {
    await withRetry(
      async () => {
        const response = await fetch(`${caddyAdminUrl}/load`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(caddyConfig),
        });

        if (!response.ok) {
          const errorText = await response.text();
          const error = new Error(`Caddy API error (${response.status}): ${errorText}`);
          (error as Error & { status?: number }).status = response.status;
          throw error;
        }
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        shouldRetry: (err) => {
          if (isNetworkError(err)) {
            return true;
          }
          const status = (err as Error & { status?: number }).status;
          if (status && isRetryableStatus(status)) {
            return true;
          }
          return false;
        },
        onRetry: (attempt, err, delayMs) => {
          logger.warn({ attempt, error: err.message, delayMs }, 'Retrying Caddy config update');
        },
      }
    );

    // Success - update tracking state
    state.lastConfigHash = configHash;
    state.lastGoodConfig = caddyConfig;
    state.consecutiveFailures = 0;
    logger.info('Caddy config updated via Admin API');
    return true;
  } catch (err) {
    state.consecutiveFailures++;
    const error = err as Error & { status?: number };

    // If this is a 4xx error (invalid config) and we have a last good config, try to restore it
    if (error.status && error.status >= 400 && error.status < 500 && state.lastGoodConfig) {
      logger.warn({ err, consecutiveFailures: state.consecutiveFailures },
        'Caddy rejected config, attempting to restore last known good config');

      const restored = await restoreLastGoodConfig(caddyAdminUrl, state);
      if (restored) {
        logger.info('Successfully restored last known good Caddy config');
      } else {
        logger.error('Failed to restore last known good Caddy config');
      }
    }

    logger.error({ err, consecutiveFailures: state.consecutiveFailures },
      'Failed to update Caddy config after retries');
    return false;
  }
}

/**
 * Reset Caddy state to allow retrying after failures.
 */
export function resetCaddyState(state: CaddyManagerState): void {
  state.consecutiveFailures = 0;
  state.lastConfigHash = null;
  logger.info('Caddy state reset - next updateAndReload will apply config');
}

/**
 * Get the current Caddy integration status.
 */
export function getCaddyStatus(state: CaddyManagerState): {
  consecutiveFailures: number;
  hasLastGoodConfig: boolean;
  isCircuitOpen: boolean;
} {
  return {
    consecutiveFailures: state.consecutiveFailures,
    hasLastGoodConfig: state.lastGoodConfig !== null,
    isCircuitOpen: state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES,
  };
}

/**
 * Generate Caddyfile format configuration (for reference/debugging).
 */
export function generateCaddyfile(
  routes: ProxyRoute[],
  serviceRoutes: ServiceRoute[],
  apiPort: number
): string {
  // Web UI route blocks - use handle_path for automatic prefix stripping
  const webUiBlocks = routes.map(route => `
  # ${route.appName} Web UI on ${route.serverName}
  handle_path ${route.path}* {
    reverse_proxy ${route.upstream}
  }`).join('\n');

  // HTTP service route blocks - use handle_path for automatic prefix stripping
  const httpServiceRoutes = serviceRoutes.filter(r => r.routeType === 'http');
  const httpServiceBlocks = httpServiceRoutes.map(route => `
  # ${route.serviceName} (${route.appName}) on ${route.serverName}
  handle_path ${route.externalPath}* {
    reverse_proxy http://${route.upstreamHost}:${route.upstreamPort}
  }`).join('\n');

  // TCP service routes (layer4)
  const tcpServiceRoutes = serviceRoutes.filter(r => r.routeType === 'tcp');
  const tcpBlocks = tcpServiceRoutes.map(route => `
# ${route.serviceName} (${route.appName}) TCP on ${route.serverName}
:${route.externalPort} {
  route {
    proxy ${route.upstreamHost}:${route.upstreamPort}
  }
}`).join('\n');

  // Combine HTTP and TCP configs
  const httpConfig = `# OwnPrem Caddy Configuration
# Auto-generated - do not edit manually

{
  auto_https off
}

:443 {
  tls internal

  # OwnPrem Core UI (static files)
  handle / {
    root * /opt/ownprem/ui/dist
    file_server
    try_files {path} /index.html
  }

  # OwnPrem Core API
  handle /api/* {
    reverse_proxy localhost:${apiPort}
  }

  # WebSocket for real-time updates
  handle /socket.io/* {
    reverse_proxy localhost:${apiPort}
  }

  # HTTP Service Endpoints
${httpServiceBlocks}

  # App Web UIs
${webUiBlocks}

  # Fallback to UI for SPA routing
  handle {
    root * /opt/ownprem/ui/dist
    file_server
    try_files {path} /index.html
  }
}
`;

  // Layer4 config is separate (requires layer4 module)
  const layer4Config = tcpServiceRoutes.length > 0 ? `
# ========================================
# TCP Service Proxying (requires layer4 module)
# Install: xcaddy build --with github.com/mholt/caddy-l4
# ========================================

${tcpBlocks}
` : '';

  return httpConfig + layer4Config;
}

/**
 * Generate development Caddyfile.
 */
export function generateDevCaddyfile(
  webUiRoutes: ProxyRoute[],
  serviceRoutes: ServiceRoute[],
  apiPort: number,
  domain: string
): string {
  const httpRoutes = serviceRoutes.filter(r => r.routeType === 'http');
  const tcpRoutes = serviceRoutes.filter(r => r.routeType === 'tcp');
  const devUiPort = config.caddy.devUiPort;

  let caddyConfig = `# OwnPrem Development Caddyfile
# Proxies to Vite dev server and API

{
  local_certs
}

${domain} {
  tls internal

  # API proxy
  handle /api/* {
    reverse_proxy localhost:${apiPort}
  }

  # WebSocket proxy
  handle /socket.io/* {
    reverse_proxy localhost:${apiPort}
  }

  # Health endpoints
  handle /health {
    reverse_proxy localhost:${apiPort}
  }

  handle /ready {
    reverse_proxy localhost:${apiPort}
  }
`;

  // Add app Web UI routes - use handle_path for automatic prefix stripping
  for (const route of webUiRoutes) {
    caddyConfig += `
  # ${route.appName} Web UI on ${route.serverName}
  handle_path ${route.path}* {
    reverse_proxy ${route.upstream}
  }
`;
  }

  // Add HTTP service routes - use handle_path for automatic prefix stripping
  for (const route of httpRoutes) {
    caddyConfig += `
  # ${route.serviceName} (${route.appName})
  handle_path ${route.externalPath}* {
    reverse_proxy http://${route.upstreamHost}:${route.upstreamPort}
  }
`;
  }

  caddyConfig += `
  # Everything else to Vite dev server
  handle {
    reverse_proxy localhost:${devUiPort}
  }
}
`;

  // Add TCP service routes (layer4)
  if (tcpRoutes.length > 0) {
    caddyConfig += `
# ========================================
# TCP Service Proxying (requires layer4 module)
# ========================================

`;
    for (const route of tcpRoutes) {
      caddyConfig += `# ${route.serviceName} (${route.appName})
:${route.externalPort} {
  route {
    proxy ${route.upstreamHost}:${route.upstreamPort}
  }
}
`;
    }
  }

  return caddyConfig;
}
