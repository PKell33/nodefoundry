import type { Server as SocketServer } from 'socket.io';

/**
 * WebSocket instance holder and broadcast utilities.
 * Extracted to break circular dependency between agentHandler.ts, commandDispatcher.ts, and index.ts.
 */

let io: SocketServer | null = null;

/**
 * Set the WebSocket server instance.
 * Called by websocket/index.ts during initialization.
 */
export function setIo(server: SocketServer | null): void {
  io = server;
}

/**
 * Get the WebSocket server instance.
 */
export function getIo(): SocketServer {
  if (!io) {
    throw new Error('WebSocket server not initialized');
  }
  return io;
}

/**
 * Broadcast deployment status change to authenticated UI clients only.
 * Sensitive information should not be exposed to unauthenticated connections.
 */
export function broadcastDeploymentStatus(data: {
  deploymentId: string;
  appName: string;
  serverId: string;
  status: string;
  previousStatus?: string;
  routeActive?: boolean;
}): void {
  if (io) {
    // Emit only to authenticated clients (joined 'authenticated' room)
    io.to('authenticated').emit('deployment:status', {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }
}
