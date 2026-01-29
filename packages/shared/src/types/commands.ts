import type { ServerMetrics } from './server.js';

export interface AgentCommand {
  id: string;
  action: 'install' | 'configure' | 'start' | 'stop' | 'restart' | 'uninstall' | 'getLogs';
  appName: string;
  payload?: CommandPayload;
}

export interface CommandPayload {
  version?: string;
  files?: ConfigFile[];
  env?: Record<string, string>;
  logOptions?: LogRequestPayload;
}

export interface LogRequestPayload {
  lines?: number;
  since?: string;
  grep?: string;
  source?: 'journalctl' | 'file' | 'auto';
  // Custom log file path (supports ${dataDir}, ${appName} variables)
  logPath?: string;
  // Systemd service name if different from app name
  serviceName?: string;
}

export interface ConfigFile {
  path: string;
  content: string;
  mode?: string;
  owner?: string;
}

export interface CommandResult {
  commandId: string;
  status: 'success' | 'error';
  message?: string;
  duration?: number;
}

export interface CommandAck {
  commandId: string;
  receivedAt: Date;
}

export interface AgentStatusReport {
  serverId: string;
  timestamp: Date;
  metrics: ServerMetrics;
  apps: AppStatus[];
}

export interface AppStatus {
  name: string;
  status: 'running' | 'stopped' | 'error' | 'not-installed';
  version?: string;
  syncProgress?: number;
  blockHeight?: number;
  torAddresses?: Record<string, string>;
}

export interface LogResult {
  commandId: string;
  logs: string[];
  source: 'journalctl' | 'file';
  hasMore: boolean;
  status: 'success' | 'error';
  message?: string;
}

export type CommandAction = AgentCommand['action'];
