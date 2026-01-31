import { z } from 'zod';

// Valid Linux capabilities that can be assigned to service binaries
// These are in setcap format: cap_name=+ep (effective and permitted)
// This is a subset of common capabilities; expand as needed for specific apps
export const VALID_LINUX_CAPABILITIES = [
  'cap_net_bind_service=+ep',  // Bind to ports < 1024
  'cap_net_raw=+ep',           // Use raw sockets
  'cap_net_admin=+ep',         // Network configuration
  'cap_sys_ptrace=+ep',        // Process tracing
  'cap_dac_override=+ep',      // Bypass file permission checks
  'cap_dac_read_search=+ep',   // Bypass file read permission
  'cap_chown=+ep',             // Change file ownership
  'cap_setuid=+ep',            // Set user ID
  'cap_setgid=+ep',            // Set group ID
  'cap_fowner=+ep',            // Bypass ownership checks
  'cap_kill=+ep',              // Send signals to processes
  'cap_sys_admin=+ep',         // Various admin operations
  'cap_ipc_lock=+ep',          // Lock memory
  'cap_sys_resource=+ep',      // Override resource limits
  'cap_mknod=+ep',             // Create special files
] as const;

// Pattern for valid service names: must start with ownprem- prefix
// to ensure they are controlled by the privileged helper whitelist
const SERVICE_NAME_PATTERN = /^ownprem-[a-z0-9][a-z0-9-]*$/;

// Pattern to detect path traversal attempts
const containsPathTraversal = (path: string): boolean => {
  // Check for .. sequences that could escape directories
  return path.includes('..') || path.includes('\0');
};

export const AppSourceSchema = z.object({
  type: z.enum(['binary', 'git', 'apt']),
  githubRepo: z.string().optional(),
  // P1: Validate download URLs to prevent malicious sources
  downloadUrl: z.string().url('Must be a valid URL').startsWith('https://', 'Must use HTTPS for security').optional(),
  checksumUrl: z.string().url('Must be a valid URL').startsWith('https://', 'Must use HTTPS for security').optional(),
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
  // P1: Validate paths to prevent path traversal attacks
  path: z.string()
    .startsWith('/', 'Path must be absolute')
    .refine(
      (path) => !containsPathTraversal(path),
      'Path cannot contain parent directory references (..) or null bytes'
    )
    .refine(
      (path) => !/\/\.(?!\.)/.test(path) || path.includes('/.local'),  // Allow .local for XDG paths
      'Path cannot contain hidden directories (except .local)'
    ),
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
  logFile: z.string()
    .refine(
      (path) => !containsPathTraversal(path),
      'Log file path cannot contain parent directory references (..)'
    )
    .optional(),
  // P0: Validate serviceName to prevent path traversal in systemd service paths
  // Service names must match ownprem-{appname} pattern to be controlled by privileged helper
  serviceName: z.string()
    .regex(
      SERVICE_NAME_PATTERN,
      'Service name must match pattern: ownprem-{appname} (lowercase alphanumeric with hyphens)'
    )
    .max(64, 'Service name must be 64 characters or less')
    .optional(),
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
  // P0: Linux capabilities for the service binary
  // Only allow whitelisted capabilities to prevent privilege escalation
  capabilities: z.array(
    z.enum(VALID_LINUX_CAPABILITIES, {
      errorMap: () => ({
        message: `Must be a valid Linux capability: ${VALID_LINUX_CAPABILITIES.join(', ')}`
      })
    })
  ).optional(),
  // Config file templates to render and deploy
  configTemplates: z.array(ConfigTemplateSchema).optional(),
});

export type ValidatedAppManifest = z.infer<typeof AppManifestSchema>;
