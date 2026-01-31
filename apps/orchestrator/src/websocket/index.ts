import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { setupAgentHandler, shutdownAgentHandler } from './agentHandler.js';
import { setIo, getIo, broadcastDeploymentStatus } from './broadcast.js';
import { wsLogger } from '../lib/logger.js';

// Re-export from broadcast module for backwards compatibility
export { getIo, broadcastDeploymentStatus };

export function createWebSocket(httpServer: HttpServer): SocketServer {
  const io = new SocketServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  setIo(io);
  setupAgentHandler(io);

  wsLogger.info('WebSocket server initialized');
  return io;
}

/**
 * Gracefully shutdown WebSocket server.
 * Notifies all agents, waits for pending commands, then closes connections.
 */
export async function shutdownWebSocket(): Promise<void> {
  let io: SocketServer;
  try {
    io = getIo();
  } catch {
    // WebSocket not initialized
    return;
  }

  // Shutdown agent handler (broadcasts to agents, waits for pending commands)
  await shutdownAgentHandler(io);

  // Close the Socket.io server
  await new Promise<void>((resolve) => {
    io.close(() => {
      resolve();
    });
  });

  setIo(null);
}
