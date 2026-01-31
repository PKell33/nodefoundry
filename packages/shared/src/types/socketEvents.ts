/**
 * Socket.IO Event Types
 *
 * Provides type-safe event definitions for all WebSocket communication between:
 * - Orchestrator ↔ Agent
 * - Orchestrator ↔ Browser UI
 */

import type { ServerMetrics, NetworkInfo } from './server.js';
import type { DeploymentStatus } from './deployment.js';
import type {
  AgentCommand,
  AgentStatusReport,
  CommandResult,
  CommandAck,
  LogResult,
  LogStreamLine,
  LogStreamStatus,
} from './commands.js';

// =============================================================================
// Agent Authentication
// =============================================================================

/**
 * Auth payload sent by agent during WebSocket handshake
 */
export interface AgentAuth {
  serverId: string;
  token: string | null;
}

/**
 * Validates that an unknown value conforms to AgentAuth interface
 */
export function isValidAgentAuth(auth: unknown): auth is AgentAuth {
  if (!auth || typeof auth !== 'object') return false;
  const obj = auth as Record<string, unknown>;
  return typeof obj.serverId === 'string' &&
    (obj.token === null || typeof obj.token === 'string');
}

// =============================================================================
// Orchestrator → Agent Events
// =============================================================================

export interface OrchestratorToAgentEvents {
  /** Heartbeat ping */
  ping: () => void;

  /** Send command to agent for execution */
  command: (command: AgentCommand) => void;

  /** Request immediate status report from agent */
  request_status: () => void;
}

// =============================================================================
// Agent → Orchestrator Events
// =============================================================================

export interface AgentToOrchestratorEvents {
  /** Heartbeat pong response */
  pong: () => void;

  /** Periodic status report with metrics and app states */
  status: (report: AgentStatusReport) => void;

  /** Acknowledgment that command was received */
  'command:ack': (ack: CommandAck) => void;

  /** Command execution completed (success or error) */
  'command:result': (result: CommandResult) => void;

  /** Log request result */
  'logs:result': (result: LogResult) => void;

  /** Log stream line (real-time streaming) */
  'logs:stream:line': (line: LogStreamLine) => void;

  /** Log stream status change */
  'logs:stream:status': (status: LogStreamStatus) => void;
}

// =============================================================================
// Orchestrator → Browser UI Events
// =============================================================================

export interface ServerStatusPayload {
  serverId: string;
  status: 'online' | 'offline' | 'error';
  metrics?: ServerMetrics;
  networkInfo?: NetworkInfo;
  apps?: Array<{
    name: string;
    status: 'running' | 'stopped' | 'error' | 'not-installed';
    version?: string;
    syncProgress?: number;
    blockHeight?: number;
  }>;
  timestamp: Date;
}

export interface ServerConnectedPayload {
  serverId: string;
  timestamp: Date;
}

export interface ServerDisconnectedPayload {
  serverId: string;
  timestamp: Date;
}

export interface DeploymentStatusPayload {
  deploymentId: string;
  appName: string;
  serverId: string;
  status: DeploymentStatus;
  message?: string;
  timestamp: Date;
}

export interface ConnectAckPayload {
  connected: boolean;
  authenticated: boolean;
}

export interface OrchestratorToBrowserEvents {
  /** Server status update (metrics, app states) */
  'server:status': (payload: ServerStatusPayload) => void;

  /** Agent connected to orchestrator */
  'server:connected': (payload: ServerConnectedPayload) => void;

  /** Agent disconnected from orchestrator */
  'server:disconnected': (payload: ServerDisconnectedPayload) => void;

  /** Orchestrator is shutting down */
  'server:shutdown': () => void;

  /** Deployment status changed */
  'deployment:status': (payload: DeploymentStatusPayload) => void;

  /** Log stream line for subscribed deployment */
  'deployment:log': (line: LogStreamLine) => void;

  /** Log stream status for subscribed deployment */
  'deployment:log:status': (status: LogStreamStatus) => void;

  /** Command result (for commands initiated by this client) */
  'command:result': (result: CommandResult) => void;

  /** Connection acknowledgment with auth status */
  'connect_ack': (payload: ConnectAckPayload) => void;
}

// =============================================================================
// Browser UI → Orchestrator Events
// =============================================================================

export interface LogSubscription {
  deploymentId: string;
}

export interface BrowserToOrchestratorEvents {
  /** Subscribe to deployment log stream */
  'subscribe:logs': (subscription: LogSubscription) => void;

  /** Unsubscribe from deployment log stream */
  'unsubscribe:logs': (subscription: LogSubscription) => void;
}

// =============================================================================
// Combined Types for Socket.IO Server/Client
// =============================================================================

/**
 * Events the agent socket can emit (to orchestrator)
 */
export type AgentSocketEmitEvents = AgentToOrchestratorEvents;

/**
 * Events the agent socket can receive (from orchestrator)
 */
export type AgentSocketListenEvents = OrchestratorToAgentEvents;

/**
 * Events the browser socket can emit (to orchestrator)
 */
export type BrowserSocketEmitEvents = BrowserToOrchestratorEvents;

/**
 * Events the browser socket can receive (from orchestrator)
 */
export type BrowserSocketListenEvents = OrchestratorToBrowserEvents;
