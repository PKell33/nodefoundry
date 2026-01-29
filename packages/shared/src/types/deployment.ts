export interface Deployment {
  id: string;
  serverId: string;
  appName: string;
  groupId?: string;
  version: string;
  config: Record<string, unknown>;
  status: DeploymentStatus;
  statusMessage?: string;
  torAddresses?: Record<string, string>;
  installedAt: Date;
  updatedAt: Date;
}

export type DeploymentStatus =
  | 'pending'
  | 'installing'
  | 'configuring'
  | 'running'
  | 'stopped'
  | 'error'
  | 'updating'
  | 'uninstalling';
