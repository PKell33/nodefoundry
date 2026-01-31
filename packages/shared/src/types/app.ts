export interface AppManifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  category: 'database' | 'web' | 'networking' | 'monitoring' | 'utility' | 'system' | 'bitcoin' | 'indexer' | 'explorer';

  // System app flags
  system?: boolean;      // Part of OwnPrem infrastructure
  mandatory?: boolean;   // Cannot be uninstalled from core server
  singleton?: boolean;   // Only one instance allowed per cluster

  source: AppSource;

  conflicts?: string[];

  provides?: ServiceDefinition[];
  requires?: ServiceRequirement[];

  tor?: TorService[];

  webui?: WebUI;

  logging?: {
    // Path to log file, supports variables: ${dataDir}, ${appName}
    logFile?: string;
    // Systemd service name if different from app name
    serviceName?: string;
  };

  configSchema: ConfigField[];

  /** Configuration file templates to render during installation */
  configTemplates?: ConfigTemplate[];

  resources?: {
    minMemory?: string;
    minDisk?: string;
  };

  // System app additional config
  dependencies?: AppDependency[];
  dataDirectories?: DataDirectory[];
  serviceUser?: string;
  serviceGroup?: string;
  capabilities?: string[];  // Linux capabilities, e.g., ['cap_net_bind_service=+ep']
}

export interface AppSource {
  type: 'binary' | 'git' | 'apt';
  githubRepo?: string;
  downloadUrl?: string;
  checksumUrl?: string;
  gitUrl?: string;
  tagPrefix?: string;
}

export interface ServiceDefinition {
  name: string;
  port: number;
  protocol: 'tcp' | 'http' | 'zmq' | 'https';
  description?: string;
  internal?: boolean;    // Only accessible within OwnPrem infrastructure
  credentials?: {
    type: 'rpc' | 'token' | 'password';
    fields: string[];
  };
}

export interface AppDependency {
  name: string;
  downloadUrl?: string;
  binaryName?: string;
}

export interface DataDirectory {
  path: string;
  description?: string;
}

export interface ServiceRequirement {
  service: string;
  optional?: boolean;
  locality: 'same-server' | 'any-server' | 'prefer-same-server';
  description?: string;
  injectAs?: {
    host?: string;
    port?: string;
    credentials?: Record<string, string>;
  };
}

export interface TorService {
  name: string;
  virtualPort: number;
  targetPort: number;
}

export interface WebUI {
  enabled: boolean;
  port: number;
  basePath: string;
}

export interface ConfigField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'password';
  label: string;
  description?: string;
  default?: unknown;
  options?: string[];
  required?: boolean;
  generated?: boolean;
  secret?: boolean;
  inheritFrom?: string;
}

/**
 * Configuration template for rendering config files from templates.
 * Used to define source template files and their destination paths.
 */
export interface ConfigTemplate {
  /** Template file path relative to app definition directory */
  source: string;
  /** Destination path on the target system */
  destination: string;
  /** File permissions (e.g., '0644') */
  mode?: string;
  /** Owner in user:group format (e.g., 'caddy:caddy') */
  owner?: string;
}

export type AppCategory = AppManifest['category'];
