/**
 * Type definitions for agent handler.
 */

import type { Socket } from 'socket.io';

export interface ServerRow {
  id: string;
  auth_token: string | null;
  is_core: number;
}

export interface AgentConnection {
  socket: Socket;
  serverId: string;
  lastSeen: Date;
  heartbeatInterval?: NodeJS.Timeout;
}

export interface DeploymentRow {
  id: string;
  app_name: string;
  status: string;
  route_active: number | null;
}

// Heartbeat configuration
export const HEARTBEAT_INTERVAL = 30000; // 30 seconds
export const HEARTBEAT_TIMEOUT = 90000;  // 90 seconds

// Shutdown timeout
export const SHUTDOWN_TIMEOUT = 30000; // 30 seconds
