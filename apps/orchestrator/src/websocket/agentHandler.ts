/**
 * Agent handler - main WebSocket connection management.
 * Coordinates agent connections, authentication, and event routing.
 */

import type { Socket, Server as SocketServer } from 'socket.io';
import { getDb } from '../db/index.js';
import { wsLogger } from '../lib/logger.js';
import { mutexManager } from '../lib/mutexManager.js';
import type {
  AgentStatusReport,
  CommandResult,
  CommandAck,
  LogResult,
  LogStreamLine,
  LogStreamStatus,
} from '@ownprem/shared';
import { isValidAgentAuth } from '@ownprem/shared';

// Import from extracted modules
import type { AgentConnection } from './agentTypes.js';
import { HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT, SHUTDOWN_TIMEOUT } from './agentTypes.js';
import { authenticateAgent, hashToken } from './agentAuth.js';
import { handleStatusReport } from './statusHandler.js';
import { handleBrowserClient } from './browserClient.js';

import {
  handleLogResult,
  handleLogStreamLine,
  handleLogStreamStatus,
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

// Agent connections
const connectedAgents = new Map<string, AgentConnection>();

// Re-export hashToken for external use
export { hashToken } from './agentAuth.js';

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
 * Throws an error if the agent for the given server is not connected.
 * Use this to guard operations that require an active agent connection.
 */
export function requireAgentConnected(serverId: string): void {
  if (!connectedAgents.has(serverId)) {
    throw new Error(`Server ${serverId} is not connected`);
  }
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

export function setupAgentHandler(io: SocketServer): void {
  // Start cleanup interval for stale connections
  setInterval(() => {
    cleanupStaleConnections();
  }, HEARTBEAT_INTERVAL);

  io.on('connection', (socket: Socket) => {
    const clientIp = socket.handshake.address;

    // Validate auth payload structure
    if (!isValidAgentAuth(socket.handshake.auth)) {
      // Not a valid agent auth - treat as browser client
      handleBrowserClient(io, socket, clientIp, getAgentSocket);
      return;
    }

    const { serverId, token } = socket.handshake.auth;

    // Authenticate the agent
    const authResult = authenticateAgent(serverId, token ?? undefined, clientIp);
    if (!authResult.success) {
      socket.disconnect();
      return;
    }

    const db = getDb();

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
