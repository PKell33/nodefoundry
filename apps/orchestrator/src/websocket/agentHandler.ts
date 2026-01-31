import type { Socket, Server as SocketServer } from 'socket.io';
import { timingSafeEqual, createHmac } from 'crypto';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { wsLogger } from '../lib/logger.js';
import { mutexManager } from '../lib/mutexManager.js';
import { authService } from '../services/authService.js';
import { proxyManager } from '../services/proxyManager.js';
import { broadcastDeploymentStatus } from './index.js';
import type { AgentStatusReport, CommandResult, CommandAck, LogResult, LogStreamLine, LogStreamStatus } from '@ownprem/shared';

// Import from modular handlers
import {
  handleLogResult,
  handleLogStreamLine,
  handleLogStreamStatus,
  handleLogSubscription,
  handleLogUnsubscription,
  initClientLogSubscriptions,
  cleanupClientLogSubscriptions,
  cleanupPendingLogRequestsForServer,
  clearPendingLogRequests,
  requestLogs as requestLogsInternal,
} from './logStreamHandler.js';

import {
  handleCommandResult,
  handleCommandAck,
  cleanupPendingCommandsForServer,
  sendCommand as sendCommandInternal,
  sendCommandWithResult as sendCommandWithResultInternal,
  getPendingCommandCount,
  abortPendingCommands,
  hasPendingCommands,
} from './commandDispatcher.js';

import {
  autoMountServerStorage,
  sendMountCommand as sendMountCommandInternal,
} from './mountHandler.js';

interface AgentAuth {
  serverId?: string;
  token?: string | null;
}

interface ServerRow {
  id: string;
  auth_token: string | null;
  is_core: number;
}

interface AgentConnection {
  socket: Socket;
  serverId: string;
  lastSeen: Date;
  heartbeatInterval?: NodeJS.Timeout;
}

// Agent connections
const connectedAgents = new Map<string, AgentConnection>();

// Browser client tracking
const browserClients = new Set<Socket>();
const authenticatedBrowserClients = new Set<Socket>();

// Heartbeat configuration
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 90000;  // 90 seconds

// Shutdown timeout
const SHUTDOWN_TIMEOUT = 30000; // 30 seconds

/**
 * Get a connected agent's socket by server ID.
 */
function getAgentSocket(serverId: string): Socket | undefined {
  return connectedAgents.get(serverId)?.socket;
}

export function getConnectedAgents(): Map<string, Socket> {
  const result = new Map<string, Socket>();
  for (const [id, conn] of connectedAgents) {
    result.set(id, conn.socket);
  }
  return result;
}

export function isAgentConnected(serverId: string): boolean {
  return connectedAgents.has(serverId);
}

/**
 * Hash a token for storage using HMAC-SHA256.
 */
export function hashToken(token: string): string {
  const hmacKey = config.tokens.hmacKey;
  if (!hmacKey) {
    throw new Error('Token HMAC key not configured. Set SECRETS_KEY environment variable.');
  }
  return createHmac('sha256', hmacKey).update(token).digest('hex');
}

/**
 * Securely compare tokens using timing-safe comparison.
 */
function verifyToken(providedToken: string, storedHash: string): boolean {
  const providedHash = hashToken(providedToken);
  const providedBuffer = Buffer.from(providedHash, 'hex');
  const storedBuffer = Buffer.from(storedHash, 'hex');

  if (providedBuffer.length !== storedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, storedBuffer);
}

export function setupAgentHandler(io: SocketServer): void {
  // Start cleanup interval for stale connections
  setInterval(() => {
    cleanupStaleConnections();
  }, HEARTBEAT_INTERVAL);

  io.on('connection', (socket: Socket) => {
    const auth = socket.handshake.auth as AgentAuth;
    const { serverId, token } = auth;
    const clientIp = socket.handshake.address;

    // Check if this is an agent connection (has serverId) or browser client
    if (!serverId) {
      handleBrowserClient(io, socket, clientIp);
      return;
    }

    // Validate auth token
    const db = getDb();
    const server = db.prepare('SELECT id, auth_token, is_core FROM servers WHERE id = ?').get(serverId) as ServerRow | undefined;

    if (!server) {
      wsLogger.warn({ serverId, clientIp }, 'Agent connection rejected: unknown server');
      socket.disconnect();
      return;
    }

    // Core server requires connection from localhost
    if (server.is_core) {
      const isLocalhost = clientIp === '127.0.0.1' ||
                          clientIp === '::1' ||
                          clientIp === '::ffff:127.0.0.1' ||
                          clientIp === 'localhost';

      if (!isLocalhost) {
        wsLogger.warn({ serverId, clientIp }, 'Core agent connection rejected: must connect from localhost');
        socket.disconnect();
        return;
      }
      wsLogger.debug({ serverId, clientIp }, 'Core agent authenticated via localhost verification');
    } else {
      if (!token) {
        wsLogger.warn({ serverId, clientIp }, 'Agent connection rejected: missing token');
        socket.disconnect();
        return;
      }

      // Check agent_tokens table for new-style tokens
      const tokenHash = hashToken(token);
      const agentTokenRow = db.prepare(`
        SELECT id FROM agent_tokens
        WHERE server_id = ? AND token_hash = ?
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
      `).get(serverId, tokenHash) as { id: string } | undefined;

      if (agentTokenRow) {
        db.prepare('UPDATE agent_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(agentTokenRow.id);
        wsLogger.debug({ serverId, tokenId: agentTokenRow.id }, 'Agent authenticated via agent_tokens');
      } else if (server.auth_token) {
        if (!verifyToken(token, server.auth_token)) {
          wsLogger.warn({ serverId, clientIp }, 'Agent connection rejected: invalid token');
          socket.disconnect();
          return;
        }
        wsLogger.debug({ serverId }, 'Agent authenticated via legacy auth_token');
      } else {
        wsLogger.warn({ serverId, clientIp }, 'Agent connection rejected: no valid token');
        socket.disconnect();
        return;
      }
    }

    // Use mutex to safely handle connection replacement
    mutexManager.withServerLock(serverId, async () => {
      // Disconnect existing connection for this server
      const existingConn = connectedAgents.get(serverId);
      if (existingConn) {
        wsLogger.info({ serverId }, 'Disconnecting existing agent connection');
        if (existingConn.heartbeatInterval) {
          clearInterval(existingConn.heartbeatInterval);
        }
        existingConn.socket.disconnect();
      }

      wsLogger.info({ serverId, clientIp }, 'Agent connected');

      // Create connection entry
      const connection: AgentConnection = {
        socket,
        serverId,
        lastSeen: new Date(),
      };

      // Set up heartbeat
      connection.heartbeatInterval = setInterval(() => {
        socket.emit('ping');
      }, HEARTBEAT_INTERVAL);

      connectedAgents.set(serverId, connection);

      // Update server status
      db.prepare(`
        UPDATE servers SET agent_status = 'online', last_seen = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(serverId);

      // Emit to clients
      io.emit('server:connected', { serverId, timestamp: new Date() });

      // Request immediate status report
      socket.emit('request_status');
      wsLogger.debug({ serverId }, 'Requested immediate status report from agent');

      // Check for mounts that should be auto-mounted
      autoMountServerStorage(serverId, getAgentSocket).catch(err => {
        wsLogger.error({ serverId, err }, 'Error auto-mounting storage');
      });
    });

    // Handle pong (heartbeat response)
    socket.on('pong', () => {
      const conn = connectedAgents.get(serverId);
      if (conn) {
        conn.lastSeen = new Date();
      }
    });

    // Handle status reports from agent
    socket.on('status', (report: AgentStatusReport) => {
      const conn = connectedAgents.get(serverId);
      if (conn) {
        conn.lastSeen = new Date();
      }
      handleStatusReport(io, serverId, report).catch(err => {
        wsLogger.error({ serverId, err }, 'Error handling status report');
      });
    });

    // Handle command acknowledgment
    socket.on('command:ack', (ack: CommandAck) => {
      handleCommandAck(serverId, ack);
    });

    // Handle command results
    socket.on('command:result', (result: CommandResult) => {
      handleCommandResult(io, serverId, result).catch(err => {
        wsLogger.error({ serverId, commandId: result.commandId, err }, 'Error handling command result');
      });
    });

    // Handle log results
    socket.on('logs:result', (result: LogResult) => {
      handleLogResult(serverId, result);
    });

    // Handle log stream lines
    socket.on('logs:stream:line', (line: LogStreamLine) => {
      handleLogStreamLine(line);
    });

    // Handle log stream status
    socket.on('logs:stream:status', (status: LogStreamStatus) => {
      handleLogStreamStatus(serverId, status);
    });

    // Handle disconnect
    socket.on('disconnect', (reason) => {
      wsLogger.info({ serverId, reason }, 'Agent disconnected');

      const conn = connectedAgents.get(serverId);
      if (conn?.heartbeatInterval) {
        clearInterval(conn.heartbeatInterval);
      }
      connectedAgents.delete(serverId);

      cleanupPendingCommandsForServer(serverId);
      cleanupPendingLogRequestsForServer(serverId);
      mutexManager.cleanupServerMutex(serverId);

      db.prepare(`
        UPDATE servers SET agent_status = 'offline', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(serverId);

      io.emit('server:disconnected', { serverId, timestamp: new Date() });
    });
  });
}

/**
 * Handle browser client WebSocket connections.
 */
function handleBrowserClient(io: SocketServer, socket: Socket, clientIp: string): void {
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

  // Handle log stream subscription
  socket.on('subscribe:logs', async (data: { deploymentId: string }) => {
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

  // Handle log stream unsubscription
  socket.on('unsubscribe:logs', (data: { deploymentId: string; streamId?: string }) => {
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
 * Clean up connections that haven't responded to heartbeats.
 */
function cleanupStaleConnections(): void {
  const now = Date.now();
  const db = getDb();

  for (const [serverId, conn] of connectedAgents) {
    const lastSeenMs = conn.lastSeen.getTime();
    if (now - lastSeenMs > HEARTBEAT_TIMEOUT) {
      wsLogger.warn({ serverId, lastSeen: conn.lastSeen }, 'Disconnecting stale agent connection');

      if (conn.heartbeatInterval) {
        clearInterval(conn.heartbeatInterval);
      }
      conn.socket.disconnect();
      connectedAgents.delete(serverId);

      db.prepare(`
        UPDATE servers SET agent_status = 'offline', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(serverId);
    }
  }
}

/**
 * Handle status report from agent.
 */
async function handleStatusReport(io: SocketServer, serverId: string, report: AgentStatusReport): Promise<void> {
  const db = getDb();

  // Update server metrics
  db.prepare(`
    UPDATE servers SET metrics = ?, network_info = ?, last_seen = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    JSON.stringify(report.metrics),
    report.networkInfo ? JSON.stringify(report.networkInfo) : null,
    serverId
  );

  let routesChanged = false;

  // Update deployment statuses
  for (const app of report.apps) {
    const deployment = db.prepare(`
      SELECT d.id, d.status, pr.active as route_active
      FROM deployments d
      LEFT JOIN proxy_routes pr ON pr.deployment_id = d.id
      WHERE d.server_id = ? AND d.app_name = ?
    `).get(serverId, app.name) as { id: string; status: string; route_active: number | null } | undefined;

    if (deployment) {
      const newStatus = mapAppStatusToDeploymentStatus(app.status);
      const previousStatus = deployment.status;
      const hasRoute = deployment.route_active !== null;
      const shouldRouteBeActive = newStatus === 'running';

      await mutexManager.withDeploymentLock(deployment.id, async () => {
        const result = db.prepare(`
          UPDATE deployments SET status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status != 'installing' AND status != 'configuring' AND status != 'uninstalling'
        `).run(newStatus, deployment.id);

        const statusChanged = result.changes > 0 && previousStatus !== newStatus;

        if (statusChanged) {
          if (hasRoute) {
            await proxyManager.setRouteActive(deployment.id, shouldRouteBeActive);
            wsLogger.info({
              deploymentId: deployment.id,
              appName: app.name,
              routeActive: shouldRouteBeActive,
            }, 'Web UI route state updated based on agent status');
          }

          await proxyManager.setServiceRoutesActiveByDeployment(deployment.id, shouldRouteBeActive);
          routesChanged = true;
        }

        if (statusChanged) {
          broadcastDeploymentStatus({
            deploymentId: deployment.id,
            appName: app.name,
            serverId,
            status: newStatus,
            previousStatus,
            routeActive: hasRoute ? shouldRouteBeActive : undefined,
          });
        }
      });
    }
  }

  if (routesChanged) {
    try {
      await proxyManager.updateAndReload();
      wsLogger.info({ serverId }, 'Caddy reloaded after route updates from status report');
    } catch (err) {
      wsLogger.error({ serverId, err }, 'Failed to reload Caddy after route updates');
    }
  }

  io.to('authenticated').emit('server:status', {
    serverId,
    timestamp: report.timestamp,
    metrics: report.metrics,
    networkInfo: report.networkInfo,
    apps: report.apps,
  });
}

function mapAppStatusToDeploymentStatus(appStatus: string): string {
  switch (appStatus) {
    case 'running': return 'running';
    case 'stopped': return 'stopped';
    case 'error': return 'error';
    default: return 'stopped';
  }
}

// ==================
// Exported API
// ==================

export async function requestLogs(
  serverId: string,
  appName: string,
  options: { lines?: number; since?: string; grep?: string; logPath?: string; serviceName?: string } = {},
  timeoutMs: number = 30000
): Promise<import('@ownprem/shared').LogResult> {
  return requestLogsInternal(serverId, appName, options, timeoutMs, getAgentSocket);
}

export function sendCommand(
  serverId: string,
  command: { id: string; action: string; appName: string; payload?: unknown },
  deploymentId?: string
): boolean {
  return sendCommandInternal(serverId, command, deploymentId, getAgentSocket);
}

/**
 * Send a command and wait for the result.
 * Unlike sendCommand, this returns a promise that resolves when the command completes.
 * Use this for operations where you need to know the result before proceeding.
 */
export function sendCommandAndWait(
  serverId: string,
  command: { id: string; action: string; appName: string; payload?: unknown },
  deploymentId?: string
): Promise<import('@ownprem/shared').CommandResult> {
  return sendCommandWithResultInternal(serverId, command, getAgentSocket, deploymentId);
}

export function sendMountCommand(
  serverId: string,
  command: {
    id: string;
    action: 'mountStorage' | 'unmountStorage' | 'checkMount';
    appName: string;
    payload: { mountOptions: import('@ownprem/shared').MountCommandPayload };
  }
): Promise<import('@ownprem/shared').CommandResult> {
  return sendMountCommandInternal(serverId, command, getAgentSocket);
}

export { getPendingCommandCount };

/**
 * Gracefully shutdown the agent handler.
 */
export async function shutdownAgentHandler(io: SocketServer): Promise<void> {
  wsLogger.info('Starting graceful shutdown of agent handler');

  io.emit('server:shutdown', { timestamp: new Date() });
  wsLogger.info({ agentCount: connectedAgents.size }, 'Broadcast shutdown notification to agents');

  // Wait for pending commands
  const startTime = Date.now();
  while (hasPendingCommands()) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= SHUTDOWN_TIMEOUT) {
      wsLogger.warn({ pendingCount: getPendingCommandCount() }, 'Shutdown timeout - aborting pending commands');
      abortPendingCommands();
      break;
    }

    wsLogger.debug({ pendingCount: getPendingCommandCount(), elapsed }, 'Waiting for pending commands');
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Clear all heartbeat intervals and disconnect agents
  for (const [serverId, conn] of connectedAgents) {
    if (conn.heartbeatInterval) {
      clearInterval(conn.heartbeatInterval);
    }
    conn.socket.disconnect(true);
    mutexManager.cleanupServerMutex(serverId);
  }
  connectedAgents.clear();

  clearPendingLogRequests();

  wsLogger.info('Agent handler shutdown complete');
}
