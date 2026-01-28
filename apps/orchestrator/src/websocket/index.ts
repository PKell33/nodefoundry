import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { setupAgentHandler } from './agentHandler.js';

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
