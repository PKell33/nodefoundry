/**
 * Browser client WebSocket handling.
 * Manages browser connections and log subscriptions.
 */

import type { Socket, Server as SocketServer } from 'socket.io';
import { wsLogger } from '../lib/logger.js';
import { authService } from '../services/authService.js';
import {
  handleLogSubscription,
  handleLogUnsubscription,
  initClientLogSubscriptions,
  cleanupClientLogSubscriptions,
} from './logStreamHandler.js';
import {
  validateBrowserEvent,
  LogSubscriptionSchema,
  LogUnsubscriptionSchema,
} from './browserValidation.js';

// Browser client tracking
const browserClients = new Set<Socket>();
const authenticatedBrowserClients = new Set<Socket>();

/**
 * Get the count of connected browser clients.
 */
export function getBrowserClientCount(): number {
  return browserClients.size;
}

/**
 * Get the count of authenticated browser clients.
 */
export function getAuthenticatedClientCount(): number {
  return authenticatedBrowserClients.size;
}

/**
 * Handle browser client WebSocket connections.
 */
export function handleBrowserClient(
  io: SocketServer,
  socket: Socket,
  clientIp: string,
  getAgentSocket: (serverId: string) => Socket | undefined
): void {
  const cookies = socket.handshake.headers.cookie || '';
  const tokenMatch = cookies.match(/access_token=([^;]+)/);
  const accessToken = tokenMatch?.[1];

  let isAuthenticated = false;
  let userId: string | undefined;

  if (accessToken) {
    const payload = authService.verifyAccessToken(accessToken);
    if (payload) {
      isAuthenticated = true;
      userId = payload.userId;
      wsLogger.debug({ clientIp, userId }, 'Browser client authenticated');
    }
  }

  browserClients.add(socket);
  if (isAuthenticated) {
    authenticatedBrowserClients.add(socket);
    socket.join('authenticated');
  }
  initClientLogSubscriptions(socket);
  wsLogger.info({ clientIp, isAuthenticated, totalClients: browserClients.size }, 'Browser client connected');

  socket.emit('connect_ack', { connected: true, authenticated: isAuthenticated });

  // Handle log stream subscription (with Zod validation)
  socket.on('subscribe:logs', async (rawData: unknown) => {
    const data = validateBrowserEvent(LogSubscriptionSchema, rawData, 'subscribe:logs', clientIp);
    if (!data) {
      socket.emit('deployment:log:status', {
        deploymentId: 'unknown',
        status: 'error',
        message: 'Invalid subscription request',
      });
      return;
    }

    if (!authenticatedBrowserClients.has(socket)) {
      socket.emit('deployment:log:status', {
        deploymentId: data.deploymentId,
        status: 'error',
        message: 'Authentication required to view logs',
      });
      wsLogger.warn({ clientIp }, 'Unauthenticated client attempted to subscribe to logs');
      return;
    }
    await handleLogSubscription(socket, data.deploymentId, getAgentSocket);
  });

  // Handle log stream unsubscription (with Zod validation)
  socket.on('unsubscribe:logs', (rawData: unknown) => {
    const data = validateBrowserEvent(LogUnsubscriptionSchema, rawData, 'unsubscribe:logs', clientIp);
    if (!data) return; // Invalid payload, already logged

    handleLogUnsubscription(socket, data.streamId, getAgentSocket);
  });

  socket.on('disconnect', (reason) => {
    browserClients.delete(socket);
    authenticatedBrowserClients.delete(socket);
    cleanupClientLogSubscriptions(socket, getAgentSocket);
    wsLogger.debug({ clientIp, reason, totalClients: browserClients.size }, 'Browser client disconnected');
  });
}

/**
 * Clean up all browser client connections.
 */
export function cleanupAllBrowserClients(): void {
  browserClients.clear();
  authenticatedBrowserClients.clear();
}
