import type { Socket, Server as SocketServer } from 'socket.io';
import { getDb } from '../db/index.js';
import { wsLogger } from '../lib/logger.js';
import { mutexManager } from '../lib/mutexManager.js';
import { updateDeploymentStatus } from '../lib/deploymentHelpers.js';
import { proxyManager } from '../services/proxyManager.js';
import { broadcastDeploymentStatus } from './broadcast.js';
import type { CommandResult, CommandAck, DeploymentStatus } from '@ownprem/shared';

// Pending commands - maps commandId to tracking info for ack/timeout
export interface PendingCommand {
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
export const ACK_TIMEOUT = 10000; // 10 seconds to acknowledge receipt

// Completion timeouts by action type
export const COMPLETION_TIMEOUTS: Record<string, number> = {
  install: 10 * 60 * 1000,    // 10 minutes
  configure: 60 * 1000,        // 1 minute
  start: 30 * 1000,            // 30 seconds
  stop: 30 * 1000,             // 30 seconds
  restart: 60 * 1000,          // 1 minute
  uninstall: 2 * 60 * 1000,    // 2 minutes
  mountStorage: 60 * 1000,        // 1 minute
  unmountStorage: 30 * 1000,      // 30 seconds
  checkMount: 10 * 1000,          // 10 seconds
  configureKeepalived: 2 * 60 * 1000, // 2 minutes (may need to install package)
  checkKeepalived: 10 * 1000,     // 10 seconds
};

/**
 * Handle command result from agent.
 */
export async function handleCommandResult(io: SocketServer, serverId: string, result: CommandResult): Promise<void> {
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

  // Get command info to check if already timed out
  const commandRow = db.prepare('SELECT deployment_id, action, status FROM command_log WHERE id = ?').get(result.commandId) as { deployment_id: string | null; action: string; status: string } | undefined;

  // If command was already timed out, don't overwrite the timeout status
  // This prevents race conditions where late results overwrite error states
  if (commandRow?.status === 'timeout') {
    wsLogger.warn({
      commandId: result.commandId,
      serverId,
      status: result.status,
    }, 'Ignoring late command result for timed-out command');
    return;
  }

  // Update command log only if not already in terminal state
  db.prepare(`
    UPDATE command_log SET status = ?, result_message = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status NOT IN ('timeout', 'error', 'success')
  `).run(result.status, result.message || null, result.commandId);

  // Update deployment status with mutex protection (only if command was pending)
  const deploymentIdFromCommand = commandRow?.deployment_id;
  if (pending && deploymentIdFromCommand) {
    await mutexManager.withDeploymentLock(deploymentIdFromCommand, async () => {
      const newStatus = getDeploymentStatusFromCommand(commandRow.action, result.status);
      if (newStatus) {
        updateDeploymentStatus(deploymentIdFromCommand, newStatus, result.message);
      }
    });
  }

  // Emit result to authenticated clients only (contains command output)
  io.to('authenticated').emit('command:result', {
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

/**
 * Map command action and result to deployment status.
 */
function getDeploymentStatusFromCommand(action: string, resultStatus: string): DeploymentStatus | null {
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

/**
 * Handle command acknowledgment from agent.
 * Clears the ack timeout and starts the completion timeout.
 */
export function handleCommandAck(serverId: string, ack: CommandAck): void {
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
        updateDeploymentStatus(stillPending.deploymentId, 'error', 'Command timed out waiting for completion');
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
 * Updates both command_log and deployment status to 'error'.
 */
export function cleanupPendingCommandsForServer(serverId: string): void {
  const db = getDb();

  for (const [commandId, pending] of pendingCommands) {
    if (pending.serverId === serverId) {
      clearTimeout(pending.ackTimeout);
      if (pending.completionTimeout) {
        clearTimeout(pending.completionTimeout);
      }
      pendingCommands.delete(commandId);
      pending.reject(new Error('Agent disconnected'));

      // Update command log
      db.prepare(`
        UPDATE command_log SET status = 'error', result_message = 'Agent disconnected', completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
      `).run(commandId);

      // Also update deployment status if this command was for a deployment
      if (pending.deploymentId) {
        db.prepare(`
          UPDATE deployments SET status = 'error', status_message = 'Agent disconnected during ${pending.action}', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status IN ('installing', 'configuring', 'uninstalling')
        `).run(pending.deploymentId);
        wsLogger.warn({
          commandId,
          deploymentId: pending.deploymentId,
          action: pending.action,
        }, 'Deployment marked as error due to agent disconnect');
      }
    }
  }
}

/**
 * Send a command to an agent.
 * Sets up acknowledgment and completion timeouts.
 * Returns true if the command was sent, false if the agent is not connected.
 */
export function sendCommand(
  serverId: string,
  command: { id: string; action: string; appName: string; payload?: unknown },
  deploymentId: string | undefined,
  getAgentSocket: (serverId: string) => Socket | undefined
): boolean {
  const agentSocket = getAgentSocket(serverId);
  if (!agentSocket) {
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
        updateDeploymentStatus(deploymentId, 'error', 'Agent did not acknowledge command');
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

  agentSocket.emit('command', command);
  wsLogger.info({ serverId, action: command.action, appName: command.appName, commandId: command.id }, 'Command sent');
  return true;
}

/**
 * Send a command and wait for the result.
 * Returns a promise that resolves with the command result.
 * Logs the command to command_log for audit trail.
 */
export function sendCommandWithResult(
  serverId: string,
  command: { id: string; action: string; appName: string; payload?: unknown },
  getAgentSocket: (serverId: string) => Socket | undefined,
  deploymentId?: string
): Promise<CommandResult> {
  const agentSocket = getAgentSocket(serverId);
  if (!agentSocket) {
    return Promise.reject(new Error(`Agent not connected: ${serverId}`));
  }

  // Log the command for audit trail
  const db = getDb();
  db.prepare(`
    INSERT INTO command_log (id, server_id, deployment_id, action, payload, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `).run(command.id, serverId, deploymentId || null, command.action, JSON.stringify({ appName: command.appName, ...(command.payload || {}) }));

  return new Promise((resolve, reject) => {
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
          updateDeploymentStatus(deploymentId, 'error', 'Agent did not acknowledge command');
        }

        reject(new Error('Agent did not acknowledge command'));
      }
    }, ACK_TIMEOUT);

    // Track the pending command
    pendingCommands.set(command.id, {
      resolve,
      reject,
      ackTimeout,
      acknowledged: false,
      deploymentId,
      action: command.action,
      serverId,
    });

    agentSocket.emit('command', command);
    wsLogger.info({ serverId, action: command.action, commandId: command.id, deploymentId }, 'Command sent (awaiting result)');
  });
}

/**
 * Get the count of pending commands.
 */
export function getPendingCommandCount(): number {
  return pendingCommands.size;
}

/**
 * Abort all pending commands (for shutdown).
 */
export function abortPendingCommands(): void {
  for (const [commandId, pending] of pendingCommands) {
    clearTimeout(pending.ackTimeout);
    if (pending.completionTimeout) {
      clearTimeout(pending.completionTimeout);
    }
    pending.reject(new Error('Orchestrator shutting down'));
    pendingCommands.delete(commandId);
  }
}

/**
 * Check if there are pending commands.
 */
export function hasPendingCommands(): boolean {
  return pendingCommands.size > 0;
}
