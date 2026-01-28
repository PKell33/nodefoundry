import type { Socket, Server as SocketServer } from 'socket.io';
import { getDb } from '../db/index.js';
import type { AgentStatusReport, CommandResult, ServerMetrics } from '@nodefoundry/shared';

interface AgentAuth {
  serverId: string;
  token: string | null;
}

interface ServerRow {
  id: string;
  auth_token: string | null;
  is_foundry: number;
}

const connectedAgents = new Map<string, Socket>();

export function getConnectedAgents(): Map<string, Socket> {
  return connectedAgents;
}

export function isAgentConnected(serverId: string): boolean {
  return connectedAgents.has(serverId);
}

export function setupAgentHandler(io: SocketServer): void {
  io.on('connection', (socket: Socket) => {
    const auth = socket.handshake.auth as AgentAuth;
    const { serverId, token } = auth;

    if (!serverId) {
      console.warn('Agent connection rejected: no serverId');
      socket.disconnect();
      return;
    }

    // Validate auth token
    const db = getDb();
    const server = db.prepare('SELECT id, auth_token, is_foundry FROM servers WHERE id = ?').get(serverId) as ServerRow | undefined;

    if (!server) {
      console.warn(`Agent connection rejected: unknown server ${serverId}`);
      socket.disconnect();
      return;
    }

    // Foundry doesn't need a token (local connection)
    if (!server.is_foundry && server.auth_token !== token) {
      console.warn(`Agent connection rejected: invalid token for ${serverId}`);
      socket.disconnect();
      return;
    }

    console.log(`Agent connected: ${serverId}`);
    connectedAgents.set(serverId, socket);

    // Update server status
    db.prepare(`
      UPDATE servers SET agent_status = 'online', last_seen = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(serverId);

    // Emit to clients that server is connected
    io.emit('server:connected', { serverId, timestamp: new Date() });

    // Handle status reports from agent
    socket.on('status', (report: AgentStatusReport) => {
      handleStatusReport(io, serverId, report);
    });

    // Handle command results from agent
    socket.on('command:result', (result: CommandResult) => {
      handleCommandResult(io, serverId, result);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`Agent disconnected: ${serverId}`);
      connectedAgents.delete(serverId);

      db.prepare(`
        UPDATE servers SET agent_status = 'offline', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(serverId);

      io.emit('server:disconnected', { serverId, timestamp: new Date() });
    });
  });
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

  // Update command log
  db.prepare(`
    UPDATE command_log SET status = ?, result_message = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(result.status, result.message || null, result.commandId);

  // Emit result to clients
  io.emit('command:result', {
    serverId,
    ...result,
  });

  console.log(`Command ${result.commandId} completed: ${result.status}${result.message ? ` - ${result.message}` : ''}`);
}

export function sendCommand(serverId: string, command: { id: string; action: string; appName: string; payload?: unknown }): boolean {
  const socket = connectedAgents.get(serverId);
  if (!socket) {
    console.warn(`Cannot send command to ${serverId}: not connected`);
    return false;
  }

  // Log the command
  const db = getDb();
  db.prepare(`
    INSERT INTO command_log (id, server_id, action, payload, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `).run(command.id, serverId, command.action, JSON.stringify(command.payload || {}));

  socket.emit('command', command);
  console.log(`Command sent to ${serverId}: ${command.action} ${command.appName}`);
  return true;
}
