import { createServer } from 'http';
import { config } from './config.js';
import { initDb, closeDb } from './db/index.js';
import { createApi, initializeApi } from './api/index.js';
import { createWebSocket, shutdownWebSocket } from './websocket/index.js';
import { secretsManager } from './services/secretsManager.js';
import { proxyManager } from './services/proxyManager.js';
import logger from './lib/logger.js';

// Track shutdown state for graceful shutdown
let isShuttingDown = false;

/**
 * Check if the server is shutting down.
 * Used by health endpoints to return 503 during shutdown.
 */
export function isServerShuttingDown(): boolean {
  return isShuttingDown;
}

async function main(): Promise<void> {
  logger.info({ env: config.nodeEnv }, 'Starting Ownprem Orchestrator');

  // Validate secrets configuration (will throw in production without SECRETS_KEY)
  secretsManager.validateConfiguration();

  // Initialize database
  initDb();

  // Initialize API services (creates default user in dev mode)
  await initializeApi();

  // Create Express app
  const app = createApi();

  // Create HTTP server
  const httpServer = createServer(app);

  // Initialize WebSocket
  createWebSocket(httpServer);

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
    if (isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }
    isShuttingDown = true;
    logger.info('Starting graceful shutdown...');

    try {
      // 1. Shutdown WebSocket (notifies agents, waits for pending commands)
      await shutdownWebSocket();
      logger.info('WebSocket shutdown complete');

      // 2. Close HTTP server (stop accepting new connections)
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logger.info('HTTP server closed');

      // 3. Close database
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
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start orchestrator');
  process.exit(1);
});
