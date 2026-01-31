import { z } from 'zod';

export const AppSourceSchema = z.object({
  type: z.enum(['binary', 'git', 'apt']),
  githubRepo: z.string().optional(),
  downloadUrl: z.string().optional(),
  checksumUrl: z.string().optional(),
  gitUrl: z.string().url().optional(),
  tagPrefix: z.string().optional(),
});

export const ServiceDefinitionSchema = z.object({
  name: z.string(),
  port: z.number().int().positive(),
  protocol: z.enum(['tcp', 'http', 'zmq', 'https']),
  description: z.string().optional(),
  internal: z.boolean().optional(),
  credentials: z.object({
    type: z.enum(['rpc', 'token', 'password']),
    fields: z.array(z.string()),
  }).optional(),
});

export const AppDependencySchema = z.object({
  name: z.string(),
  downloadUrl: z.string().optional(),
  binaryName: z.string().optional(),
});

export const DataDirectorySchema = z.object({
  path: z.string().startsWith('/'),
  description: z.string().optional(),
});

export const ConfigTemplateSchema = z.object({
  source: z.string(),          // Template file path relative to app definition
  destination: z.string(),     // Destination path on the target system
  mode: z.string().optional(), // File permissions (e.g., '0644')
  owner: z.string().optional(), // Owner (e.g., 'caddy:caddy')
});

export const ServiceRequirementSchema = z.object({
  service: z.string(),
  optional: z.boolean().optional(),
  locality: z.enum(['same-server', 'any-server', 'prefer-same-server']),
  description: z.string().optional(),
  injectAs: z.object({
    host: z.string().optional(),
    port: z.string().optional(),
    credentials: z.record(z.string()).optional(),
  }).optional(),
});

export const TorServiceSchema = z.object({
  name: z.string(),
  virtualPort: z.number().int().positive(),
  targetPort: z.number().int().positive(),
});

export const WebUISchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().positive(),
  basePath: z.string().startsWith('/'),
});

export const LoggingSchema = z.object({
  logFile: z.string().optional(),
  serviceName: z.string().optional(),
});

export const ConfigFieldSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'select', 'password']),
  label: z.string(),
  description: z.string().optional(),
  default: z.unknown().optional(),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  generated: z.boolean().optional(),
  secret: z.boolean().optional(),
  inheritFrom: z.string().optional(),
});

export const AppManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  displayName: z.string(),
  description: z.string(),
  version: z.string(),
  category: z.enum(['database', 'web', 'networking', 'monitoring', 'utility', 'system', 'bitcoin', 'indexer', 'explorer']),
  // System app flags
  system: z.boolean().optional(),
  mandatory: z.boolean().optional(),
  singleton: z.boolean().optional(),
  source: AppSourceSchema,
  conflicts: z.array(z.string()).optional(),
  provides: z.array(ServiceDefinitionSchema).optional(),
  requires: z.array(ServiceRequirementSchema).optional(),
  tor: z.array(TorServiceSchema).optional(),
  webui: WebUISchema.optional(),
  logging: LoggingSchema.optional(),
  configSchema: z.array(ConfigFieldSchema),
  resources: z.object({
    minMemory: z.string().optional(),
    minDisk: z.string().optional(),
  }).optional(),
  // System app additional config
  dependencies: z.array(AppDependencySchema).optional(),
  dataDirectories: z.array(DataDirectorySchema).optional(),
  serviceUser: z.string().optional(),
  serviceGroup: z.string().optional(),
  // Linux capabilities for the service binary (e.g., 'cap_net_bind_service+ep')
  capabilities: z.array(z.string()).optional(),
  // Config file templates to render and deploy
  configTemplates: z.array(ConfigTemplateSchema).optional(),
});

export type ValidatedAppManifest = z.infer<typeof AppManifestSchema>;
