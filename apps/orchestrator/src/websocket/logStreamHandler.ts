import type { Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { wsLogger } from '../lib/logger.js';
import type { LogResult, LogStreamLine, LogStreamStatus } from '@ownprem/shared';

// Log stream subscriptions: maps streamId to { deploymentId, subscribedClients }
export interface LogStreamSubscription {
  deploymentId: string;
  serverId: string;
  appName: string;
  clients: Set<Socket>;
}

// Pending log requests - maps commandId to resolve/reject callbacks
const pendingLogRequests = new Map<string, {
  resolve: (result: LogResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  serverId: string;
}>();

// Active log streams
const activeLogStreams = new Map<string, LogStreamSubscription>();

// Map browser client socket to their subscribed stream IDs (for cleanup)
const clientLogSubscriptions = new Map<Socket, Set<string>>();

/**
 * Initialize log subscriptions tracking for a new client socket.
 */
export function initClientLogSubscriptions(socket: Socket): void {
  clientLogSubscriptions.set(socket, new Set());
}

/**
 * Get the client log subscriptions map (for cleanup on disconnect).
 */
export function getClientLogSubscriptions(socket: Socket): Set<string> | undefined {
  return clientLogSubscriptions.get(socket);
}

/**
 * Handle log result from agent.
 */
export function handleLogResult(serverId: string, result: LogResult): void {
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
 * Handle a log stream line from an agent - forward to subscribed clients.
 */
export function handleLogStreamLine(line: LogStreamLine): void {
  const subscription = activeLogStreams.get(line.streamId);
  if (!subscription) {
    return; // No subscribers for this stream
  }

  // Forward to all subscribed browser clients
  for (const clientSocket of subscription.clients) {
    clientSocket.emit('deployment:log', {
      deploymentId: subscription.deploymentId,
      streamId: line.streamId,
      line: line.line,
      timestamp: line.timestamp,
    });
  }
}

/**
 * Handle log stream status from an agent.
 */
export function handleLogStreamStatus(serverId: string, status: LogStreamStatus): void {
  wsLogger.info({
    streamId: status.streamId,
    appName: status.appName,
    status: status.status,
    message: status.message,
  }, 'Log stream status update');

  const subscription = activeLogStreams.get(status.streamId);
  if (!subscription) {
    return;
  }

  // Notify subscribed clients
  for (const clientSocket of subscription.clients) {
    clientSocket.emit('deployment:log:status', {
      deploymentId: subscription.deploymentId,
      streamId: status.streamId,
      status: status.status,
      message: status.message,
    });
  }

  // Clean up if stream stopped or errored
  if (status.status === 'stopped' || status.status === 'error') {
    // Clean up client tracking
    for (const clientSocket of subscription.clients) {
      const clientSubs = clientLogSubscriptions.get(clientSocket);
      if (clientSubs) {
        clientSubs.delete(status.streamId);
      }
    }
    activeLogStreams.delete(status.streamId);
  }
}

/**
 * Handle browser client subscribing to log stream.
 */
export async function handleLogSubscription(
  clientSocket: Socket,
  deploymentId: string,
  getAgentSocket: (serverId: string) => Socket | undefined
): Promise<void> {
  const db = getDb();

  // Look up deployment to get serverId and appName
  const deployment = db.prepare(`
    SELECT d.id, d.server_id, d.app_name, s.agent_status
    FROM deployments d
    JOIN servers s ON d.server_id = s.id
    WHERE d.id = ?
  `).get(deploymentId) as { id: string; server_id: string; app_name: string; agent_status: string } | undefined;

  if (!deployment) {
    clientSocket.emit('deployment:log:status', {
      deploymentId,
      status: 'error',
      message: 'Deployment not found',
    });
    return;
  }

  if (deployment.agent_status !== 'online') {
    clientSocket.emit('deployment:log:status', {
      deploymentId,
      status: 'error',
      message: 'Server is offline',
    });
    return;
  }

  // Generate a unique stream ID using cryptographically secure random UUID
  const streamId = randomUUID();

  // Check if there's already an active stream for this deployment
  for (const [existingStreamId, sub] of activeLogStreams) {
    if (sub.deploymentId === deploymentId) {
      // Reuse existing stream - just add this client
      sub.clients.add(clientSocket);
      const clientSubs = clientLogSubscriptions.get(clientSocket);
      if (clientSubs) {
        clientSubs.add(existingStreamId);
      }

      clientSocket.emit('deployment:log:status', {
        deploymentId,
        streamId: existingStreamId,
        status: 'started',
        message: 'Joined existing stream',
      });
      return;
    }
  }

  // Create new subscription
  activeLogStreams.set(streamId, {
    deploymentId,
    serverId: deployment.server_id,
    appName: deployment.app_name,
    clients: new Set([clientSocket]),
  });

  const clientSubs = clientLogSubscriptions.get(clientSocket);
  if (clientSubs) {
    clientSubs.add(streamId);
  }

  // Send command to agent to start streaming
  const agentSocket = getAgentSocket(deployment.server_id);
  if (!agentSocket) {
    activeLogStreams.delete(streamId);
    clientSocket.emit('deployment:log:status', {
      deploymentId,
      status: 'error',
      message: 'Agent not connected',
    });
    return;
  }

  // Look up service name from manifest if available
  let serviceName = deployment.app_name;
  try {
    const manifest = db.prepare(`
      SELECT manifest FROM app_manifests WHERE name = ?
    `).get(deployment.app_name) as { manifest: string } | undefined;

    if (manifest) {
      const parsed = JSON.parse(manifest.manifest);
      if (parsed.logging?.serviceName) {
        serviceName = parsed.logging.serviceName;
      }
    }
  } catch {
    // Ignore manifest lookup errors, use default
  }

  agentSocket.emit('command', {
    id: streamId,
    action: 'streamLogs',
    appName: deployment.app_name,
    payload: {
      logOptions: {
        serviceName,
      },
    },
  });

  wsLogger.info({
    streamId,
    deploymentId,
    serverId: deployment.server_id,
    appName: deployment.app_name,
  }, 'Started log stream subscription');
}

/**
 * Handle browser client unsubscribing from log stream.
 */
export function handleLogUnsubscription(
  clientSocket: Socket,
  streamId: string | undefined,
  getAgentSocket: (serverId: string) => Socket | undefined
): void {
  const clientSubs = clientLogSubscriptions.get(clientSocket);
  if (!clientSubs) return;

  // If no streamId provided, unsubscribe from all
  const streamsToCheck = streamId ? [streamId] : [...clientSubs];

  for (const sid of streamsToCheck) {
    const subscription = activeLogStreams.get(sid);
    if (!subscription) continue;

    subscription.clients.delete(clientSocket);
    clientSubs.delete(sid);

    // If no more clients, stop the stream
    if (subscription.clients.size === 0) {
      stopLogStreamForDeployment(sid, subscription.serverId, getAgentSocket);
      activeLogStreams.delete(sid);
    }
  }
}

/**
 * Send stop command to agent to stop streaming logs.
 */
function stopLogStreamForDeployment(
  streamId: string,
  serverId: string,
  getAgentSocket: (serverId: string) => Socket | undefined
): void {
  const agentSocket = getAgentSocket(serverId);
  if (!agentSocket) return;

  agentSocket.emit('command', {
    id: streamId,
    action: 'stopStreamLogs',
    appName: '', // Not needed for stop
  });

  wsLogger.info({ streamId, serverId }, 'Stopped log stream');
}

/**
 * Clean up log stream subscriptions for a disconnected client.
 */
export function cleanupClientLogSubscriptions(
  clientSocket: Socket,
  getAgentSocket: (serverId: string) => Socket | undefined
): void {
  const clientSubs = clientLogSubscriptions.get(clientSocket);
  if (clientSubs) {
    for (const streamId of clientSubs) {
      const subscription = activeLogStreams.get(streamId);
      if (subscription) {
        subscription.clients.delete(clientSocket);
        // If no more clients, stop the stream
        if (subscription.clients.size === 0) {
          stopLogStreamForDeployment(streamId, subscription.serverId, getAgentSocket);
          activeLogStreams.delete(streamId);
        }
      }
    }
    clientLogSubscriptions.delete(clientSocket);
  }
}

/**
 * Clean up pending log requests for a server (e.g., on disconnect).
 */
export function cleanupPendingLogRequestsForServer(serverId: string): void {
  for (const [commandId, pending] of pendingLogRequests) {
    if (pending.serverId === serverId) {
      clearTimeout(pending.timeout);
      pendingLogRequests.delete(commandId);
      pending.reject(new Error('Agent disconnected'));
    }
  }
}

/**
 * Request logs from an agent.
 */
export async function requestLogs(
  serverId: string,
  appName: string,
  options: { lines?: number; since?: string; grep?: string; logPath?: string; serviceName?: string } = {},
  timeoutMs: number = 30000,
  getAgentSocket: (serverId: string) => Socket | undefined
): Promise<LogResult> {
  const agentSocket = getAgentSocket(serverId);
  if (!agentSocket) {
    throw new Error(`Agent not connected: ${serverId}`);
  }

  const commandId = randomUUID();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingLogRequests.delete(commandId);
      reject(new Error('Log request timed out'));
    }, timeoutMs);

    pendingLogRequests.set(commandId, { resolve, reject, timeout, serverId });

    agentSocket.emit('command', {
      id: commandId,
      action: 'getLogs',
      appName,
      payload: { logOptions: options },
    });

    wsLogger.info({ serverId, appName, commandId }, 'Log request sent');
  });
}

/**
 * Clear all pending log requests on shutdown.
 */
export function clearPendingLogRequests(): void {
  for (const [, pending] of pendingLogRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('Orchestrator shutting down'));
  }
  pendingLogRequests.clear();
}
