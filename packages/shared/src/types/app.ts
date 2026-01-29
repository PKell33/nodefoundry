export interface AppManifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  category: 'bitcoin' | 'lightning' | 'indexer' | 'explorer' | 'utility';

  source: AppSource;

  conflicts?: string[];

  provides?: ServiceDefinition[];
  requires?: ServiceRequirement[];

  tor?: TorService[];

  webui?: WebUI;

  configSchema: ConfigField[];

  resources?: {
    minMemory?: string;
    minDisk?: string;
  };
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
  protocol: 'tcp' | 'http' | 'zmq';
  credentials?: {
    type: 'rpc' | 'token' | 'password';
    fields: string[];
  };
}

export interface ServiceRequirement {
  service: string;
  optional?: boolean;
  locality: 'same-server' | 'any-server' | 'prefer-same-server';
  injectAs: {
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

export type AppCategory = AppManifest['category'];
