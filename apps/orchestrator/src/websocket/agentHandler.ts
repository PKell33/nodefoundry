import type { Socket, Server as SocketServer } from 'socket.io';
import { timingSafeEqual, createHash } from 'crypto';
import { getDb } from '../db/index.js';
import { wsLogger } from '../lib/logger.js';
import { authService } from '../services/authService.js';
import type { AgentStatusReport, CommandResult, ServerMetrics } from '@ownprem/shared';

interface AgentAuth {
  serverId?: string;
  token?: string | null;
}

// Track browser client connections
const browserClients = new Set<Socket>();

interface ServerRow {
  id: string;
  auth_token: string | null;
  is_foundry: number;
}

interface AgentConnection {
  socket: Socket;
  serverId: string;
  lastSeen: Date;
  heartbeatInterval?: NodeJS.Timeout;
}

const connectedAgents = new Map<string, AgentConnection>();

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
    const server = db.prepare('SELECT id, auth_token, is_foundry FROM servers WHERE id = ?').get(serverId) as ServerRow | undefined;

    if (!server) {
      wsLogger.warn({ serverId, clientIp }, 'Agent connection rejected: unknown server');
      socket.disconnect();
      return;
    }

    // Foundry doesn't need a token (local connection)
    // For other servers, verify the token
    if (!server.is_foundry) {
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
      handleStatusReport(io, serverId, report);
    });

    // Handle command results from agent
    socket.on('command:result', (result: CommandResult) => {
      handleCommandResult(io, serverId, result);
    });

    // Handle disconnect
    socket.on('disconnect', (reason) => {
      wsLogger.info({ serverId, reason }, 'Agent disconnected');

      const conn = connectedAgents.get(serverId);
      if (conn?.heartbeatInterval) {
        clearInterval(conn.heartbeatInterval);
      }
      connectedAgents.delete(serverId);

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

function handleStatusReport(io: SocketServer, serverId: string, report: AgentStatusReport): void {
  const db = getDb();

  // Update server metrics
  db.prepare(`
    UPDATE servers SET metrics = ?, last_seen = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(report.metrics), serverId);

  // Update deployment statuses based on app statuses
  for (const app of report.apps) {
    const deploymentStatus = mapAppStatusToDeploymentStatus(app.status);
    db.prepare(`
      UPDATE deployments SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE server_id = ? AND app_name = ? AND status != 'installing' AND status != 'configuring' AND status != 'uninstalling'
    `).run(deploymentStatus, serverId, app.name);
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

function handleCommandResult(io: SocketServer, serverId: string, result: CommandResult): void {
  const db = getDb();

  // Get command info to update deployment status
  const commandRow = db.prepare('SELECT deployment_id, action FROM command_log WHERE id = ?').get(result.commandId) as { deployment_id: string | null; action: string } | undefined;

  // Update command log
  db.prepare(`
    UPDATE command_log SET status = ?, result_message = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(result.status, result.message || null, result.commandId);

  // Update deployment status based on command result
  if (commandRow?.deployment_id) {
    const newStatus = getDeploymentStatusFromCommand(commandRow.action, result.status);
    if (newStatus) {
      db.prepare(`
        UPDATE deployments SET status = ?, status_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(newStatus, result.message || null, commandRow.deployment_id);
    }
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

  conn.socket.emit('command', command);
  wsLogger.info({ serverId, action: command.action, appName: command.appName }, 'Command sent');
  return true;
}
