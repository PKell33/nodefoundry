import { createServer } from 'http';
import { config } from './config.js';
import { initDb, closeDb } from './db/index.js';
import { createApi } from './api/index.js';
import { createWebSocket } from './websocket/index.js';

async function main(): Promise<void> {
  console.log('Starting Nodefoundry Orchestrator...');
  console.log(`Environment: ${config.nodeEnv}`);

  // Initialize database
  initDb();

  // Create Express app
  const app = createApi();

  // Create HTTP server
  const httpServer = createServer(app);

  // Initialize WebSocket
  createWebSocket(httpServer);

  // Start listening
  httpServer.listen(config.port, () => {
    console.log(`Orchestrator listening on port ${config.port}`);
    console.log(`API: http://localhost:${config.port}/api`);
    console.log(`WebSocket: ws://localhost:${config.port}`);
  });

  // Graceful shutdown
  const shutdown = (): void => {
    console.log('\nShutting down...');
    httpServer.close(() => {
      closeDb();
      console.log('Goodbye!');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start orchestrator:', err);
  process.exit(1);
});
