/**
 * Zod validation schemas for incoming WebSocket events from agents.
 * Provides runtime validation to ensure message integrity and prevent
 * malformed data from being processed.
 */

import { z } from 'zod';
import { wsLogger } from '../lib/logger.js';

// App status schema
const AppStatusSchema = z.object({
  name: z.string().max(100),
  status: z.enum(['running', 'stopped', 'error', 'not-installed']),
  version: z.string().max(50).optional(),
  syncProgress: z.number().min(0).max(100).optional(),
  blockHeight: z.number().int().min(0).optional(),
  torAddresses: z.record(z.string()).optional(),
});

// Server metrics schema
const ServerMetricsSchema = z.object({
  cpuUsage: z.number().min(0).max(100).optional(),
  memoryUsage: z.number().min(0).max(100).optional(),
  memoryTotal: z.number().min(0).optional(),
  memoryFree: z.number().min(0).optional(),
  diskUsage: z.number().min(0).max(100).optional(),
  diskTotal: z.number().min(0).optional(),
  diskFree: z.number().min(0).optional(),
  uptime: z.number().min(0).optional(),
  loadAverage: z.array(z.number()).max(3).optional(),
}).passthrough(); // Allow additional metrics

// Network info schema
const NetworkInfoSchema = z.object({
  interfaces: z.array(z.object({
    name: z.string().max(50),
    addresses: z.array(z.string()).max(20),
    mac: z.string().max(20).optional(),
  })).max(50).optional(),
  hostname: z.string().max(256).optional(),
}).passthrough().optional();

// Agent status report schema
export const AgentStatusReportSchema = z.object({
  serverId: z.string().max(100),
  timestamp: z.union([z.date(), z.string().datetime()]),
  metrics: ServerMetricsSchema,
  networkInfo: NetworkInfoSchema,
  apps: z.array(AppStatusSchema).max(1000),
});

// Command acknowledgment schema
export const CommandAckSchema = z.object({
  commandId: z.string().max(100),
  receivedAt: z.union([z.date(), z.string().datetime()]),
});

// Mount check result schema
const MountCheckResultSchema = z.object({
  mounted: z.boolean(),
  usage: z.object({
    used: z.number().optional(),
    total: z.number().optional(),
    available: z.number().optional(),
  }).optional(),
}).optional();

// Keepalived status schema
const KeepalivedStatusSchema = z.object({
  installed: z.boolean(),
  running: z.boolean(),
  state: z.string().optional(),
}).optional();

// Command result schema
export const CommandResultSchema = z.object({
  commandId: z.string().max(100),
  status: z.enum(['success', 'error']),
  message: z.string().max(10000).optional(),
  duration: z.number().min(0).optional(),
  data: z.union([MountCheckResultSchema, KeepalivedStatusSchema]).optional(),
});

// Log result schema
export const LogResultSchema = z.object({
  commandId: z.string().max(100),
  logs: z.array(z.string().max(10000)).max(10000),
  source: z.enum(['journalctl', 'file']),
  hasMore: z.boolean(),
  status: z.enum(['success', 'error']),
  message: z.string().max(10000).optional(),
});

// Log stream line schema
export const LogStreamLineSchema = z.object({
  streamId: z.string().max(100),
  appName: z.string().max(100),
  line: z.string().max(10000),
  timestamp: z.string().max(50),
});

// Log stream status schema
export const LogStreamStatusSchema = z.object({
  streamId: z.string().max(100),
  appName: z.string().max(100),
  status: z.enum(['started', 'stopped', 'error']),
  message: z.string().max(1000).optional(),
});

// Type exports for validated data
export type ValidatedAgentStatusReport = z.infer<typeof AgentStatusReportSchema>;
export type ValidatedCommandAck = z.infer<typeof CommandAckSchema>;
export type ValidatedCommandResult = z.infer<typeof CommandResultSchema>;
export type ValidatedLogResult = z.infer<typeof LogResultSchema>;
export type ValidatedLogStreamLine = z.infer<typeof LogStreamLineSchema>;
export type ValidatedLogStreamStatus = z.infer<typeof LogStreamStatusSchema>;

/**
 * Validate and parse incoming data with a Zod schema.
 * Returns the validated data or null if validation fails.
 */
export function validateWithSchema<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  eventName: string,
  serverId?: string
): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    wsLogger.warn({
      serverId,
      eventName,
      errors: result.error.issues.slice(0, 5), // Limit error details
    }, 'Invalid WebSocket event payload');
    return null;
  }
  return result.data;
}
