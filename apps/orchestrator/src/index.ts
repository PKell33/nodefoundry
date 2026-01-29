import { createServer } from 'http';
import { config } from './config.js';
import { initDb, closeDb } from './db/index.js';
import { createApi, initializeApi } from './api/index.js';
import { createWebSocket } from './websocket/index.js';
import { secretsManager } from './services/secretsManager.js';
import logger from './lib/logger.js';

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
  httpServer.listen(config.port, '0.0.0.0', () => {
    logger.info({
      port: config.port,
      api: `http://localhost:${config.port}/api`,
      ws: `ws://localhost:${config.port}`,
    }, 'Orchestrator started');
  });

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info('Shutting down...');
    httpServer.close(() => {
      closeDb();
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start orchestrator');
  process.exit(1);
});
