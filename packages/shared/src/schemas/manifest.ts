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
  protocol: z.enum(['tcp', 'http', 'zmq']),
  credentials: z.object({
    type: z.enum(['rpc', 'token', 'password']),
    fields: z.array(z.string()),
  }).optional(),
});

export const ServiceRequirementSchema = z.object({
  service: z.string(),
  optional: z.boolean().optional(),
  locality: z.enum(['same-server', 'any-server', 'prefer-same-server']),
  injectAs: z.object({
    host: z.string().optional(),
    port: z.string().optional(),
    credentials: z.record(z.string()).optional(),
  }),
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
  category: z.enum(['bitcoin', 'lightning', 'indexer', 'explorer', 'utility']),
  source: AppSourceSchema,
  conflicts: z.array(z.string()).optional(),
  provides: z.array(ServiceDefinitionSchema).optional(),
  requires: z.array(ServiceRequirementSchema).optional(),
  tor: z.array(TorServiceSchema).optional(),
  webui: WebUISchema.optional(),
  configSchema: z.array(ConfigFieldSchema),
  resources: z.object({
    minMemory: z.string().optional(),
    minDisk: z.string().optional(),
  }).optional(),
});

export type ValidatedAppManifest = z.infer<typeof AppManifestSchema>;
