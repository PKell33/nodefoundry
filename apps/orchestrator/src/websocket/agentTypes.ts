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
  /** Generation number to detect stale command results from replaced connections */
  connectionGeneration: number;
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

/**
 * Connection generation counter per server.
 * Used to detect and reject stale command results from replaced connections.
 */
const connectionGenerations = new Map<string, number>();

/**
 * Get the next connection generation number for a server.
 * Increments and returns the generation counter.
 */
export function getNextConnectionGeneration(serverId: string): number {
  const current = connectionGenerations.get(serverId) || 0;
  const next = current + 1;
  connectionGenerations.set(serverId, next);
  return next;
}

/**
 * Get the current connection generation for a server (without incrementing).
 */
export function getCurrentConnectionGeneration(serverId: string): number | undefined {
  return connectionGenerations.get(serverId);
}

/**
 * Clean up connection generation tracking for a server.
 */
export function cleanupConnectionGeneration(serverId: string): void {
  connectionGenerations.delete(serverId);
}
