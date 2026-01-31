import { createServer } from 'http';
import { config } from './config.js';
import { initDb, closeDb } from './db/index.js';
import { createApi, initializeApi } from './api/index.js';
import { createWebSocket, shutdownWebSocket } from './websocket/index.js';
import { secretsManager } from './services/secretsManager.js';
import { proxyManager } from './services/proxyManager.js';
import { systemAppsService } from './services/systemAppsService.js';
import { deploymentHealthService } from './services/deploymentHealthService.js';
import { startSessionCleanup, stopSessionCleanup } from './jobs/sessionCleanup.js';
import { startMountStatusChecker, stopMountStatusChecker } from './jobs/mountStatusChecker.js';
import { startCertRenewal, stopCertRenewal } from './jobs/certRenewal.js';
import { runStartupRecovery } from './jobs/stateRecovery.js';
import logger from './lib/logger.js';
import { isServerShuttingDown, setServerShuttingDown } from './lib/shutdownState.js';

async function main(): Promise<void> {
  logger.info({ env: config.nodeEnv }, 'Starting Ownprem Orchestrator');

  // Log dev mode auth bypass status
  if (config.devMode.bypassAuth) {
    logger.warn('DEV AUTH BYPASS ACTIVE - authentication is disabled for development');
    logger.warn('Set ALLOW_DEV_AUTH_BYPASS=false or use production mode to disable');
  } else if (config.isDevelopment && config.devMode.productionIndicators.length > 0) {
    logger.info(
      { indicators: config.devMode.productionIndicators },
      'Dev auth bypass disabled due to production indicators'
    );
  }

  // Log JWT secret status (helpful for debugging session persistence issues)
  if (config.jwt.isEphemeral) {
    logger.warn(
      { hint: config.jwt.debugHint },
      'Using ephemeral JWT secret - sessions will not persist across restarts'
    );
  }

  // Initialize database (must be first - other services depend on it)
  initDb();

  // Validate secrets configuration (will throw in production without SECRETS_KEY)
  secretsManager.validateConfiguration();

  // Run state recovery for deployments stuck in transient states
  await runStartupRecovery();

  // Initialize API services (creates default user in dev mode)
  await initializeApi();

  // Create Express app
  const app = createApi();

  // Create HTTP server
  const httpServer = createServer(app);

  // Initialize WebSocket
  createWebSocket(httpServer);

  // Start background jobs
  startSessionCleanup();
  startMountStatusChecker();
  startCertRenewal();

  // Start deployment health monitor (detects and recovers stuck deployments)
  deploymentHealthService.start();

  // Start system apps monitor (installs mandatory apps when core agent connects)
  systemAppsService.start();

  // Start listening on all interfaces for remote access
  httpServer.listen(config.port, '0.0.0.0', async () => {
    logger.info({
      port: config.port,
      api: `http://localhost:${config.port}/api`,
      ws: `ws://localhost:${config.port}`,
    }, 'Orchestrator started');

    // Sync Caddy config on startup (ensures Caddy has correct routes after restart)
    try {
      const success = await proxyManager.updateAndReload();
      if (success) {
        logger.info('Caddy config synced via Admin API');
      } else {
        logger.warn('Failed to sync Caddy config - Caddy may not be running');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to sync Caddy config on startup');
    }
  });

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    if (isServerShuttingDown()) {
      logger.warn('Shutdown already in progress');
      return;
    }
    setServerShuttingDown(true);
    logger.info('Starting graceful shutdown...');

    try {
      // 1. Stop background jobs
      stopSessionCleanup();
      stopMountStatusChecker();
      stopCertRenewal();
      deploymentHealthService.stop();
      systemAppsService.stop();
      logger.info('Background jobs stopped');

      // 2. Shutdown WebSocket (notifies agents, waits for pending commands)
      await shutdownWebSocket();
      logger.info('WebSocket shutdown complete');

      // 3. Close HTTP server (stop accepting new connections)
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logger.info('HTTP server closed');

      // 4. Close database
      closeDb();
      logger.info('Database closed');

      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise: String(promise) }, 'Unhandled promise rejection');
  });

  // Handle uncaught exceptions - attempt graceful shutdown
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception - initiating shutdown');
    shutdown();
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start orchestrator');
  process.exit(1);
});
