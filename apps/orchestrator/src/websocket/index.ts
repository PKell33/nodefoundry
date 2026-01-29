import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { setupAgentHandler, shutdownAgentHandler } from './agentHandler.js';

let io: SocketServer | null = null;

export function createWebSocket(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  setupAgentHandler(io);

  console.log('WebSocket server initialized');
  return io;
}

export function getIo(): SocketServer {
  if (!io) {
    throw new Error('WebSocket server not initialized');
  }
  return io;
}

/**
 * Gracefully shutdown WebSocket server.
 * Notifies all agents, waits for pending commands, then closes connections.
 */
export async function shutdownWebSocket(): Promise<void> {
  if (!io) {
    return;
  }

  // Shutdown agent handler (broadcasts to agents, waits for pending commands)
  await shutdownAgentHandler(io);

  // Close the Socket.io server
  await new Promise<void>((resolve) => {
    io?.close(() => {
      resolve();
    });
  });

  io = null;
}
