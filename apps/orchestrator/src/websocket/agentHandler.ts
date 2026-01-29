import type { Socket, Server as SocketServer } from 'socket.io';
import { timingSafeEqual, createHash } from 'crypto';
import { getDb, runInTransaction } from '../db/index.js';
import { wsLogger } from '../lib/logger.js';
import { mutexManager } from '../lib/mutexManager.js';
import { authService } from '../services/authService.js';
import type { AgentStatusReport, CommandResult, CommandAck, ServerMetrics, LogResult } from '@ownprem/shared';

interface AgentAuth {
  serverId?: string;
  token?: string | null;
}

// Track browser client connections
const browserClients = new Set<Socket>();

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

const connectedAgents = new Map<string, AgentConnection>();

// Pending log requests - maps commandId to resolve/reject callbacks
const pendingLogRequests = new Map<string, {
  resolve: (result: LogResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  serverId: string;
}>();

// Pending commands - maps commandId to tracking info for ack/timeout
interface PendingCommand {
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  ackTimeout: NodeJS.Timeout;
  completionTimeout?: NodeJS.Timeout;
  acknowledged: boolean;
  deploymentId?: string;
  action: string;
  serverId: string;
}

const pendingCommands = new Map<string, PendingCommand>();

// Timeout configuration (in milliseconds)
const ACK_TIMEOUT = 10000; // 10 seconds to acknowledge receipt

// Completion timeouts by action type
const COMPLETION_TIMEOUTS: Record<string, number> = {
  install: 10 * 60 * 1000,    // 10 minutes
  configure: 60 * 1000,        // 1 minute
  start: 30 * 1000,            // 30 seconds
  stop: 30 * 1000,             // 30 seconds
  restart: 60 * 1000,          // 1 minute
  uninstall: 2 * 60 * 1000,    // 2 minutes
};

// Heartbeat configuration
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 90000;  // 90 seconds

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
 * Hash a token for storage
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Securely compare tokens using timing-safe comparison
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
      // This is a browser client - validate JWT from cookie or auth header
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

    // Core server doesn't need a token (local connection)
    // For other servers, verify the token
    if (!server.is_core) {
      if (!token || !server.auth_token) {
        wsLogger.warn({ serverId, clientIp }, 'Agent connection rejected: missing token');
        socket.disconnect();
        return;
      }

      if (!verifyToken(token, server.auth_token)) {
        wsLogger.warn({ serverId, clientIp }, 'Agent connection rejected: invalid token');
        socket.disconnect();
        return;
      }
    }

    // Use mutex to safely handle connection replacement
    mutexManager.withServerLock(serverId, async () => {
      // Disconnect existing connection for this server (prevent duplicates)
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

      // Emit to clients that server is connected
      io.emit('server:connected', { serverId, timestamp: new Date() });
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

    // Handle command acknowledgment from agent
    socket.on('command:ack', (ack: CommandAck) => {
      handleCommandAck(serverId, ack);
    });

    // Handle command results from agent
    socket.on('command:result', (result: CommandResult) => {
      handleCommandResult(io, serverId, result).catch(err => {
        wsLogger.error({ serverId, commandId: result.commandId, err }, 'Error handling command result');
      });
    });

    // Handle log results from agent
    socket.on('logs:result', (result: LogResult) => {
      handleLogResult(serverId, result);
    });

    // Handle disconnect
    socket.on('disconnect', (reason) => {
      wsLogger.info({ serverId, reason }, 'Agent disconnected');

      const conn = connectedAgents.get(serverId);
      if (conn?.heartbeatInterval) {
        clearInterval(conn.heartbeatInterval);
      }
      connectedAgents.delete(serverId);

      // Clean up pending commands for this server
      cleanupPendingCommandsForServer(serverId);

      // Clean up pending log requests for this server
      cleanupPendingLogRequestsForServer(serverId);

      // Clean up server mutex to prevent memory leak
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
 * Handle browser client WebSocket connections
 */
function handleBrowserClient(io: SocketServer, socket: Socket, clientIp: string): void {
  // Get JWT from cookie in handshake headers
  const cookies = socket.handshake.headers.cookie || '';
  const tokenMatch = cookies.match(/access_token=([^;]+)/);
  const accessToken = tokenMatch?.[1];

  if (!accessToken) {
    wsLogger.debug({ clientIp }, 'Browser client connection: no access token');
    // Allow connection without auth for now - they just won't see anything sensitive
    // The client will reconnect after login with proper auth
  } else {
    // Verify the token
    const payload = authService.verifyAccessToken(accessToken);
    if (!payload) {
      wsLogger.debug({ clientIp }, 'Browser client: invalid access token');
    } else {
      wsLogger.debug({ clientIp, userId: payload.userId }, 'Browser client authenticated');
    }
  }

  // Track this browser client
  browserClients.add(socket);
  wsLogger.info({ clientIp, totalClients: browserClients.size }, 'Browser client connected');

  // Emit connected status to this client
  socket.emit('connect_ack', { connected: true });

  socket.on('disconnect', (reason) => {
    browserClients.delete(socket);
    wsLogger.debug({ clientIp, reason, totalClients: browserClients.size }, 'Browser client disconnected');
  });
}

/**
 * Clean up connections that haven't responded to heartbeats
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

async function handleStatusReport(io: SocketServer, serverId: string, report: AgentStatusReport): Promise<void> {
  const db = getDb();

  // Update server metrics (no mutex needed - single server update)
  db.prepare(`
    UPDATE servers SET metrics = ?, last_seen = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(report.metrics), serverId);

  // Update deployment statuses - use per-deployment mutex to avoid race with command results
  // Status report only updates deployments in stable states (not installing/configuring/uninstalling)
  for (const app of report.apps) {
    // Get deployment ID for this app on this server
    const deployment = db.prepare(`
      SELECT id FROM deployments WHERE server_id = ? AND app_name = ?
    `).get(serverId, app.name) as { id: string } | undefined;

    if (deployment) {
      await mutexManager.withDeploymentLock(deployment.id, async () => {
        const deploymentStatus = mapAppStatusToDeploymentStatus(app.status);
        // Only update if not in a transient state (command results have priority)
        db.prepare(`
          UPDATE deployments SET status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status != 'installing' AND status != 'configuring' AND status != 'uninstalling'
        `).run(deploymentStatus, deployment.id);
      });
    }
  }

  // Emit status update to clients
  io.emit('server:status', {
    serverId,
    timestamp: report.timestamp,
    metrics: report.metrics,
    apps: report.apps,
  });
}

function mapAppStatusToDeploymentStatus(appStatus: string): string {
  switch (appStatus) {
    case 'running':
      return 'running';
    case 'stopped':
      return 'stopped';
    case 'error':
      return 'error';
    default:
      return 'stopped';
  }
}

async function handleCommandResult(io: SocketServer, serverId: string, result: CommandResult): Promise<void> {
  const db = getDb();

  // Clean up pending command tracking
  const pending = pendingCommands.get(result.commandId);
  if (pending) {
    clearTimeout(pending.ackTimeout);
    if (pending.completionTimeout) {
      clearTimeout(pending.completionTimeout);
    }
    pendingCommands.delete(result.commandId);

    // Resolve the pending promise
    if (result.status === 'success') {
      pending.resolve(result);
    } else {
      pending.reject(new Error(result.message || 'Command failed'));
    }
  }

  // Get command info to update deployment status (read before acquiring mutex)
  const commandRow = db.prepare('SELECT deployment_id, action FROM command_log WHERE id = ?').get(result.commandId) as { deployment_id: string | null; action: string } | undefined;

  // Update command log (no mutex needed - single command update)
  db.prepare(`
    UPDATE command_log SET status = ?, result_message = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(result.status, result.message || null, result.commandId);

  // Update deployment status with mutex protection
  if (commandRow?.deployment_id) {
    await mutexManager.withDeploymentLock(commandRow.deployment_id, async () => {
      const newStatus = getDeploymentStatusFromCommand(commandRow.action, result.status);
      if (newStatus) {
        db.prepare(`
          UPDATE deployments SET status = ?, status_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(newStatus, result.message || null, commandRow.deployment_id);
      }
    });
  }

  // Emit result to clients
  io.emit('command:result', {
    serverId,
    ...result,
  });

  wsLogger.info({
    commandId: result.commandId,
    serverId,
    status: result.status,
    message: result.message,
  }, 'Command completed');
}

function getDeploymentStatusFromCommand(action: string, resultStatus: string): string | null {
  if (resultStatus === 'error') {
    return 'error';
  }

  switch (action) {
    case 'install':
      return resultStatus === 'success' ? 'stopped' : 'error';
    case 'configure':
      return resultStatus === 'success' ? 'stopped' : 'error';
    case 'start':
      return resultStatus === 'success' ? 'running' : 'error';
    case 'stop':
      return resultStatus === 'success' ? 'stopped' : 'error';
    case 'uninstall':
      return null; // Deployment is deleted, not updated
    default:
      return null;
  }
}

function handleLogResult(serverId: string, result: LogResult): void {
  const pending = pendingLogRequests.get(result.commandId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingLogRequests.delete(result.commandId);
    pending.resolve(result);
  }

  wsLogger.debug({
    commandId: result.commandId,
    serverId,
    status: result.status,
    lineCount: result.logs.length,
  }, 'Log result received');
}

/**
 * Handle command acknowledgment from agent.
 * Clears the ack timeout and starts the completion timeout.
 */
function handleCommandAck(serverId: string, ack: CommandAck): void {
  const pending = pendingCommands.get(ack.commandId);
  if (!pending) {
    wsLogger.debug({ serverId, commandId: ack.commandId }, 'Received ack for unknown command');
    return;
  }

  if (pending.serverId !== serverId) {
    wsLogger.warn({ serverId, commandId: ack.commandId, expectedServerId: pending.serverId },
      'Received ack from wrong server');
    return;
  }

  // Clear ack timeout
  clearTimeout(pending.ackTimeout);
  pending.acknowledged = true;

  // Start completion timeout
  const completionTimeoutMs = COMPLETION_TIMEOUTS[pending.action] || 60000;
  pending.completionTimeout = setTimeout(() => {
    const stillPending = pendingCommands.get(ack.commandId);
    if (stillPending) {
      pendingCommands.delete(ack.commandId);

      // Update command log to timeout status
      const db = getDb();
      db.prepare(`
        UPDATE command_log SET status = 'timeout', result_message = 'Command completion timed out', completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(ack.commandId);

      // Update deployment status if applicable
      if (stillPending.deploymentId) {
        db.prepare(`
          UPDATE deployments SET status = 'error', status_message = 'Command timed out waiting for completion', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(stillPending.deploymentId);
      }

      stillPending.reject(new Error(`Command '${pending.action}' timed out waiting for completion`));
      wsLogger.error({
        commandId: ack.commandId,
        serverId,
        action: pending.action,
        timeoutMs: completionTimeoutMs,
      }, 'Command completion timeout');
    }
  }, completionTimeoutMs);

  wsLogger.info({
    commandId: ack.commandId,
    serverId,
    action: pending.action,
    receivedAt: ack.receivedAt,
  }, 'Command acknowledged');
}

/**
 * Clean up pending commands for a server (e.g., on disconnect).
 */
function cleanupPendingCommandsForServer(serverId: string): void {
  for (const [commandId, pending] of pendingCommands) {
    if (pending.serverId === serverId) {
      clearTimeout(pending.ackTimeout);
      if (pending.completionTimeout) {
        clearTimeout(pending.completionTimeout);
      }
      pendingCommands.delete(commandId);
      pending.reject(new Error('Agent disconnected'));

      // Update command log
      const db = getDb();
      db.prepare(`
        UPDATE command_log SET status = 'error', result_message = 'Agent disconnected', completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
      `).run(commandId);
    }
  }
}

/**
 * Clean up pending log requests for a server (e.g., on disconnect).
 */
function cleanupPendingLogRequestsForServer(serverId: string): void {
  for (const [commandId, pending] of pendingLogRequests) {
    if (pending.serverId === serverId) {
      clearTimeout(pending.timeout);
      pendingLogRequests.delete(commandId);
      pending.reject(new Error('Agent disconnected'));
    }
  }
}

export async function requestLogs(
  serverId: string,
  appName: string,
  options: { lines?: number; since?: string; grep?: string; logPath?: string; serviceName?: string } = {},
  timeoutMs: number = 30000
): Promise<LogResult> {
  const conn = connectedAgents.get(serverId);
  if (!conn) {
    throw new Error(`Agent not connected: ${serverId}`);
  }

  const commandId = `logs-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingLogRequests.delete(commandId);
      reject(new Error('Log request timed out'));
    }, timeoutMs);

    pendingLogRequests.set(commandId, { resolve, reject, timeout, serverId });

    conn.socket.emit('command', {
      id: commandId,
      action: 'getLogs',
      appName,
      payload: { logOptions: options },
    });

    wsLogger.info({ serverId, appName, commandId }, 'Log request sent');
  });
}

/**
 * Send a command to an agent.
 * Sets up acknowledgment and completion timeouts.
 * Returns true if the command was sent, false if the agent is not connected.
 */
export function sendCommand(serverId: string, command: { id: string; action: string; appName: string; payload?: unknown }, deploymentId?: string): boolean {
  const conn = connectedAgents.get(serverId);
  if (!conn) {
    wsLogger.warn({ serverId }, 'Cannot send command: agent not connected');
    return false;
  }

  // Log the command with deployment_id for status tracking
  const db = getDb();
  db.prepare(`
    INSERT INTO command_log (id, server_id, deployment_id, action, payload, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `).run(command.id, serverId, deploymentId || null, command.action, JSON.stringify({ appName: command.appName, ...(command.payload || {}) }));

  // Set up ack timeout
  const ackTimeout = setTimeout(() => {
    const pending = pendingCommands.get(command.id);
    if (pending && !pending.acknowledged) {
      pendingCommands.delete(command.id);

      // Update command log to timeout status
      db.prepare(`
        UPDATE command_log SET status = 'timeout', result_message = 'Agent did not acknowledge command', completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(command.id);

      // Update deployment status if applicable
      if (deploymentId) {
        db.prepare(`
          UPDATE deployments SET status = 'error', status_message = 'Agent did not acknowledge command', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(deploymentId);
      }

      wsLogger.error({
        commandId: command.id,
        serverId,
        action: command.action,
      }, 'Command acknowledgment timeout');
    }
  }, ACK_TIMEOUT);

  // Track the pending command
  pendingCommands.set(command.id, {
    resolve: () => {}, // Will be called by handleCommandResult
    reject: (err) => {
      wsLogger.error({ commandId: command.id, serverId, err }, 'Command rejected');
    },
    ackTimeout,
    acknowledged: false,
    deploymentId,
    action: command.action,
    serverId,
  });

  conn.socket.emit('command', command);
  wsLogger.info({ serverId, action: command.action, appName: command.appName, commandId: command.id }, 'Command sent');
  return true;
}

// Shutdown timeout for graceful shutdown
const SHUTDOWN_TIMEOUT = 30000; // 30 seconds

/**
 * Get the count of pending commands.
 */
export function getPendingCommandCount(): number {
  return pendingCommands.size;
}

/**
 * Gracefully shutdown the agent handler.
 * Broadcasts shutdown to all agents and waits for pending commands.
 */
export async function shutdownAgentHandler(io: import('socket.io').Server): Promise<void> {
  wsLogger.info('Starting graceful shutdown of agent handler');

  // Broadcast shutdown notification to all agents
  io.emit('server:shutdown', { timestamp: new Date() });
  wsLogger.info({ agentCount: connectedAgents.size }, 'Broadcast shutdown notification to agents');

  // Wait for pending commands to complete (with timeout)
  const startTime = Date.now();
  while (pendingCommands.size > 0) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= SHUTDOWN_TIMEOUT) {
      wsLogger.warn({ pendingCount: pendingCommands.size }, 'Shutdown timeout - aborting pending commands');

      // Reject remaining pending commands
      for (const [commandId, pending] of pendingCommands) {
        clearTimeout(pending.ackTimeout);
        if (pending.completionTimeout) {
          clearTimeout(pending.completionTimeout);
        }
        pending.reject(new Error('Orchestrator shutting down'));
        pendingCommands.delete(commandId);
      }
      break;
    }

    wsLogger.debug({ pendingCount: pendingCommands.size, elapsed }, 'Waiting for pending commands');
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

  // Clear pending log requests
  for (const [commandId, pending] of pendingLogRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('Orchestrator shutting down'));
  }
  pendingLogRequests.clear();

  wsLogger.info('Agent handler shutdown complete');
}
