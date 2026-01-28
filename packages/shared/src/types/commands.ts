import type { ServerMetrics } from './server.js';

export interface AgentCommand {
  id: string;
  action: 'install' | 'configure' | 'start' | 'stop' | 'restart' | 'uninstall';
  appName: string;
  payload?: CommandPayload;
}

export interface CommandPayload {
  version?: string;
  files?: ConfigFile[];
  env?: Record<string, string>;
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

export type CommandAction = AgentCommand['action'];
