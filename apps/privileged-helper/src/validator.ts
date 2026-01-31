/**
 * Privileged Helper - Request Validator
 *
 * Validates all requests against strict whitelist rules.
 * This is the security boundary - be very careful when modifying.
 */

import { realpathSync, existsSync, lstatSync } from 'fs';
import { dirname } from 'path';
import type { HelperRequest } from './types.js';

// Allowed service user names (for create_service_user)
// System users + pattern-based validation for app users
const ALLOWED_SERVICE_USERS = new Set([
  'step-ca',
  'caddy',
  'ownprem',
]);

// Pattern for valid app service user names (alphanumeric, hyphen, underscore)
const APP_USER_PATTERN = /^[a-z][a-z0-9_-]{0,30}$/;

// Allowed home directory prefixes for service users
const ALLOWED_HOME_PREFIXES = [
  '/var/lib/',
  '/opt/ownprem/apps/',
];

// Allowed directory prefixes for create_directory, set_ownership, set_permissions
// Uses broad patterns to support dynamic app deployments
export const ALLOWED_PATH_PREFIXES = [
  '/var/lib/',           // App data directories
  '/etc/step-ca',
  '/etc/caddy',
  '/etc/keepalived',
  '/etc/ownprem',
  '/var/log/',           // App log directories
  '/opt/ownprem/apps',
  '/mnt',
];

// Allowed paths for write_file
const ALLOWED_WRITE_PATHS = [
  { prefix: '/etc/systemd/system/ownprem-', suffix: '.service' },
  { prefix: '/var/lib/step-ca/', suffix: '' },
  { prefix: '/etc/step-ca/', suffix: '' },
  { prefix: '/etc/caddy/', suffix: '' },
  { prefix: '/etc/keepalived/', suffix: '' },
  { prefix: '/opt/ownprem/apps/', suffix: '' },
];

// Allowed service name patterns for systemctl
const ALLOWED_SERVICE_PATTERNS = [
  /^ownprem-[a-z0-9-]+$/,
  /^step-ca$/,
  /^caddy$/,
  /^keepalived$/,
];

// System services that don't require registration (core infrastructure)
const SYSTEM_SERVICES = new Set([
  'step-ca',
  'caddy',
  'keepalived',
  'ownprem-orchestrator',
  'ownprem-agent',
  'ownprem-privileged-helper',
  'ownprem-ca',
  'ownprem-caddy',
]);

// Directory where registered services are tracked
// Each registered service has a file: /var/lib/ownprem/services/<service-name>
const REGISTERED_SERVICES_DIR = '/var/lib/ownprem/services';

/**
 * Check if a service is registered (either a system service or has a registration file).
 * This prevents arbitrary service control via the ownprem-* pattern.
 */
function isServiceRegistered(serviceName: string): boolean {
  // System services are always allowed
  if (SYSTEM_SERVICES.has(serviceName)) {
    return true;
  }

  // Check for registration file (created by orchestrator during deployment)
  const registrationFile = `${REGISTERED_SERVICES_DIR}/${serviceName}`;
  if (existsSync(registrationFile)) {
    // Verify it's a regular file, not a symlink (prevent symlink attacks)
    try {
      const stats = lstatSync(registrationFile);
      return stats.isFile() && !stats.isSymbolicLink();
    } catch {
      return false;
    }
  }

  return false;
}

// Allowed capabilities
const ALLOWED_CAPABILITIES = [
  'cap_net_bind_service=+ep',
];

// Allowed binary paths for set_capability
const ALLOWED_CAPABILITY_PATHS = [
  /^\/opt\/ownprem\/apps\/[a-z0-9-]+\/bin\/[a-z0-9-]+$/,
];

// Allowed commands for run_as_user
const ALLOWED_RUN_COMMANDS: Record<string, RegExp[]> = {
  'step-ca': [
    /^\/opt\/ownprem\/apps\/ownprem-ca\/bin\/step$/,
  ],
  'caddy': [
    /^\/opt\/ownprem\/apps\/ownprem-caddy\/bin\/caddy$/,
  ],
};

// Valid owner format: user or user:group
const OWNER_PATTERN = /^[a-z_][a-z0-9_-]*(?::[a-z_][a-z0-9_-]*)?$/;

// Valid mode format: octal
const MODE_PATTERN = /^[0-7]{3,4}$/;

// Username pattern
const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]*$/;

// Mount point validation: must be under allowed directories
const ALLOWED_MOUNT_POINT_PREFIXES = [
  '/mnt/',
  '/var/lib/ownprem/mounts/',
];

// Mount point pattern: safe characters only
const MOUNT_POINT_PATTERN = /^\/[a-zA-Z0-9/_-]+$/;

// NFS source validation: host:/path
const NFS_SOURCE_PATTERN = /^[a-zA-Z0-9.-]+:\/[a-zA-Z0-9/_-]+$/;

// CIFS source validation: //host/share
const CIFS_SOURCE_PATTERN = /^\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_-]+$/;

// Allowed mount options (safe whitelist)
const ALLOWED_MOUNT_OPTIONS = new Set([
  // NFS options
  'vers=3', 'vers=4', 'vers=4.0', 'vers=4.1', 'vers=4.2',
  'rw', 'ro', 'sync', 'async',
  'noatime', 'atime', 'nodiratime', 'relatime',
  'hard', 'soft', 'intr', 'nointr',
  'tcp', 'udp',
  'nfsvers=3', 'nfsvers=4', 'nfsvers=4.0', 'nfsvers=4.1', 'nfsvers=4.2',
  // Common options
  'defaults', 'noexec', 'nosuid', 'nodev',
  // CIFS options (most handled by regex below)
  'nobrl', 'nolock', 'noperm',
  'sec=ntlm', 'sec=ntlmv2', 'sec=ntlmssp', 'sec=krb5', 'sec=krb5i', 'sec=none',
  'iocharset=utf8',
]);

// Parameterized mount options (validated by regex)
const MOUNT_OPTION_PATTERNS = [
  /^uid=\d+$/,
  /^gid=\d+$/,
  /^rsize=\d+$/,
  /^wsize=\d+$/,
  /^timeo=\d+$/,
  /^retrans=\d+$/,
  /^file_mode=0[0-7]{3}$/,
  /^dir_mode=0[0-7]{3}$/,
];

// Allowed apt packages (whitelist for security)
const ALLOWED_APT_PACKAGES = new Set([
  'keepalived',
  'nfs-common',
  'cifs-utils',
]);

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Resolve symlinks safely, checking both the path and its parent directories.
 * Returns the real path if safe, or null if the path escapes allowed prefixes.
 */
export function resolvePathSafely(path: string, prefixes: string[]): string | null {
  // Normalize path to prevent basic traversal
  const normalized = path.replace(/\/+/g, '/').replace(/\/$/, '');

  // Block null bytes and explicit traversal
  if (normalized.includes('\0') || normalized.includes('..')) {
    return null;
  }

  // If path exists, resolve symlinks and verify final destination
  if (existsSync(normalized)) {
    try {
      // Check if path itself is a symlink - reject symlinks pointing outside allowed areas
      const stats = lstatSync(normalized);
      if (stats.isSymbolicLink()) {
        const realPath = realpathSync(normalized);
        // Verify the resolved path is within allowed prefixes
        if (!prefixes.some(prefix => realPath.startsWith(prefix))) {
          return null; // Symlink points outside allowed directories
        }
        return realPath;
      }
      // For regular files/dirs, still resolve to catch symlinks in parent path
      const realPath = realpathSync(normalized);
      if (!prefixes.some(prefix => realPath.startsWith(prefix))) {
        return null;
      }
      return realPath;
    } catch {
      return null; // Error resolving path
    }
  }

  // Path doesn't exist yet - verify parent directory is safe
  // This handles the case of creating new files/dirs
  let parentPath = dirname(normalized);
  while (parentPath !== '/' && !existsSync(parentPath)) {
    parentPath = dirname(parentPath);
  }

  if (parentPath !== '/') {
    try {
      const realParent = realpathSync(parentPath);
      // Verify parent resolves to allowed prefix
      if (!prefixes.some(prefix =>
        realParent.startsWith(prefix) || prefix.startsWith(realParent + '/')
      )) {
        return null;
      }
    } catch {
      return null;
    }
  }

  // Verify the normalized path starts with allowed prefix
  if (!prefixes.some(prefix => normalized.startsWith(prefix))) {
    return null;
  }

  return normalized;
}

function isPathAllowed(path: string, prefixes: string[]): boolean {
  return resolvePathSafely(path, prefixes) !== null;
}

export function isWritePathAllowed(path: string): boolean {
  const normalized = path.replace(/\/+/g, '/').replace(/\/$/, '');

  if (normalized.includes('..') || normalized.includes('\0')) {
    return false;
  }

  // Check basic prefix/suffix rules first
  const matchesRule = ALLOWED_WRITE_PATHS.some(rule => {
    if (rule.suffix) {
      return normalized.startsWith(rule.prefix) && normalized.endsWith(rule.suffix);
    }
    return normalized.startsWith(rule.prefix);
  });

  if (!matchesRule) {
    return false;
  }

  // Now verify symlinks don't escape allowed areas
  // Build list of allowed prefixes from ALLOWED_WRITE_PATHS
  const allowedPrefixes = ALLOWED_WRITE_PATHS.map(r => r.prefix);

  // If path exists, verify it doesn't symlink outside allowed areas
  if (existsSync(normalized)) {
    try {
      const stats = lstatSync(normalized);
      if (stats.isSymbolicLink()) {
        const realPath = realpathSync(normalized);
        // Verify resolved path matches allowed rules
        const realMatchesRule = ALLOWED_WRITE_PATHS.some(rule => {
          if (rule.suffix) {
            return realPath.startsWith(rule.prefix) && realPath.endsWith(rule.suffix);
          }
          return realPath.startsWith(rule.prefix);
        });
        if (!realMatchesRule) {
          return false; // Symlink escapes allowed write paths
        }
      }
    } catch {
      return false;
    }
  } else {
    // Path doesn't exist - verify parent doesn't symlink outside allowed areas
    let parentPath = dirname(normalized);
    while (parentPath !== '/' && !existsSync(parentPath)) {
      parentPath = dirname(parentPath);
    }

    if (parentPath !== '/' && existsSync(parentPath)) {
      try {
        const realParent = realpathSync(parentPath);
        // Verify parent is within an allowed prefix
        if (!allowedPrefixes.some(prefix =>
          realParent.startsWith(prefix) || prefix.startsWith(realParent + '/')
        )) {
          return false;
        }
      } catch {
        return false;
      }
    }
  }

  return true;
}

export function validateRequest(request: HelperRequest): void {
  if (!request || typeof request !== 'object') {
    throw new ValidationError('Invalid request format');
  }

  switch (request.action) {
    case 'create_service_user': {
      if (!USERNAME_PATTERN.test(request.username)) {
        throw new ValidationError(`Invalid username format: ${request.username}`);
      }
      // Allow system users from explicit list OR app users matching the pattern
      if (!ALLOWED_SERVICE_USERS.has(request.username) && !APP_USER_PATTERN.test(request.username)) {
        throw new ValidationError(`User not in allowlist: ${request.username}`);
      }
      if (!ALLOWED_HOME_PREFIXES.some(p => request.homeDir.startsWith(p))) {
        throw new ValidationError(`Home directory not allowed: ${request.homeDir}`);
      }
      if (request.homeDir.includes('..')) {
        throw new ValidationError('Path traversal not allowed');
      }
      break;
    }

    case 'create_directory': {
      if (!isPathAllowed(request.path, ALLOWED_PATH_PREFIXES)) {
        throw new ValidationError(`Directory path not allowed: ${request.path}`);
      }
      if (request.owner && !OWNER_PATTERN.test(request.owner)) {
        throw new ValidationError(`Invalid owner format: ${request.owner}`);
      }
      if (request.mode && !MODE_PATTERN.test(request.mode)) {
        throw new ValidationError(`Invalid mode format: ${request.mode}`);
      }
      break;
    }

    case 'set_ownership': {
      if (!isPathAllowed(request.path, ALLOWED_PATH_PREFIXES)) {
        throw new ValidationError(`Path not allowed: ${request.path}`);
      }
      if (!OWNER_PATTERN.test(request.owner)) {
        throw new ValidationError(`Invalid owner format: ${request.owner}`);
      }
      break;
    }

    case 'set_permissions': {
      if (!isPathAllowed(request.path, ALLOWED_PATH_PREFIXES)) {
        throw new ValidationError(`Path not allowed: ${request.path}`);
      }
      if (!MODE_PATTERN.test(request.mode)) {
        throw new ValidationError(`Invalid mode format: ${request.mode}`);
      }
      break;
    }

    case 'write_file': {
      if (!isWritePathAllowed(request.path)) {
        throw new ValidationError(`Write path not allowed: ${request.path}`);
      }
      if (typeof request.content !== 'string') {
        throw new ValidationError('Content must be a string');
      }
      if (request.owner && !OWNER_PATTERN.test(request.owner)) {
        throw new ValidationError(`Invalid owner format: ${request.owner}`);
      }
      if (request.mode && !MODE_PATTERN.test(request.mode)) {
        throw new ValidationError(`Invalid mode format: ${request.mode}`);
      }
      break;
    }

    case 'copy_file': {
      if (!isPathAllowed(request.source, ALLOWED_PATH_PREFIXES)) {
        throw new ValidationError(`Source path not allowed: ${request.source}`);
      }
      if (!isWritePathAllowed(request.destination)) {
        throw new ValidationError(`Destination path not allowed: ${request.destination}`);
      }
      if (request.owner && !OWNER_PATTERN.test(request.owner)) {
        throw new ValidationError(`Invalid owner format: ${request.owner}`);
      }
      if (request.mode && !MODE_PATTERN.test(request.mode)) {
        throw new ValidationError(`Invalid mode format: ${request.mode}`);
      }
      break;
    }

    case 'systemctl': {
      const validOps = ['start', 'stop', 'restart', 'enable', 'disable', 'daemon-reload'];
      if (!validOps.includes(request.operation)) {
        throw new ValidationError(`Invalid systemctl operation: ${request.operation}`);
      }
      if (request.operation !== 'daemon-reload') {
        if (!request.service) {
          throw new ValidationError('Service name required');
        }
        // First check if service name matches allowed patterns
        if (!ALLOWED_SERVICE_PATTERNS.some(p => p.test(request.service!))) {
          throw new ValidationError(`Service not allowed: ${request.service}`);
        }
        // Then verify the service is actually registered (prevents arbitrary ownprem-* services)
        if (!isServiceRegistered(request.service)) {
          throw new ValidationError(`Service not registered: ${request.service}. Services must be deployed through the orchestrator.`);
        }
      }
      break;
    }

    case 'set_capability': {
      if (!ALLOWED_CAPABILITY_PATHS.some(p => p.test(request.path))) {
        throw new ValidationError(`Binary path not allowed for capability: ${request.path}`);
      }
      if (!ALLOWED_CAPABILITIES.includes(request.capability)) {
        throw new ValidationError(`Capability not allowed: ${request.capability}`);
      }
      break;
    }

    case 'run_as_user': {
      if (!USERNAME_PATTERN.test(request.user)) {
        throw new ValidationError(`Invalid username: ${request.user}`);
      }
      const allowedCommands = ALLOWED_RUN_COMMANDS[request.user];
      if (!allowedCommands) {
        throw new ValidationError(`User not allowed for run_as_user: ${request.user}`);
      }
      if (!allowedCommands.some(p => p.test(request.command))) {
        throw new ValidationError(`Command not allowed for user ${request.user}: ${request.command}`);
      }
      // Validate args using strict allowlist pattern
      // Only allow alphanumeric, dots, hyphens, underscores, slashes, colons, equals, commas, and at signs
      // This covers paths, options (--flag=value), URLs, and common CLI patterns
      const SAFE_ARG_PATTERN = /^[a-zA-Z0-9._\-/:=,@+]+$/;
      for (const arg of request.args) {
        // Reject null bytes (can cause string truncation)
        if (arg.includes('\0')) {
          throw new ValidationError('Null bytes not allowed in arguments');
        }
        // Reject newlines (can break argument parsing)
        if (arg.includes('\n') || arg.includes('\r')) {
          throw new ValidationError('Newlines not allowed in arguments');
        }
        // Use strict allowlist for safe characters
        if (!SAFE_ARG_PATTERN.test(arg)) {
          throw new ValidationError(`Invalid characters in argument: ${arg}. Only alphanumeric and ._-/:=,@+ are allowed.`);
        }
      }
      if (request.cwd && !isPathAllowed(request.cwd, ALLOWED_PATH_PREFIXES)) {
        throw new ValidationError(`Working directory not allowed: ${request.cwd}`);
      }
      break;
    }

    case 'mount': {
      // Validate mount type
      if (!['nfs', 'cifs'].includes(request.mountType)) {
        throw new ValidationError(`Invalid mount type: ${request.mountType}`);
      }

      // Validate mount point
      if (!MOUNT_POINT_PATTERN.test(request.mountPoint)) {
        throw new ValidationError(`Invalid mount point format: ${request.mountPoint}`);
      }
      if (request.mountPoint.includes('..')) {
        throw new ValidationError('Path traversal not allowed in mount point');
      }
      if (!ALLOWED_MOUNT_POINT_PREFIXES.some(p => request.mountPoint.startsWith(p))) {
        throw new ValidationError(`Mount point not in allowed prefix: ${request.mountPoint}`);
      }

      // Validate source
      if (request.mountType === 'nfs') {
        if (!NFS_SOURCE_PATTERN.test(request.source)) {
          throw new ValidationError(`Invalid NFS source format: ${request.source}`);
        }
      } else if (request.mountType === 'cifs') {
        if (!CIFS_SOURCE_PATTERN.test(request.source)) {
          throw new ValidationError(`Invalid CIFS source format: ${request.source}`);
        }
      }

      // Validate options if provided
      if (request.options) {
        const opts = request.options.split(',').map(o => o.trim()).filter(o => o);
        for (const opt of opts) {
          const isValid = ALLOWED_MOUNT_OPTIONS.has(opt) ||
            MOUNT_OPTION_PATTERNS.some(p => p.test(opt));
          if (!isValid) {
            throw new ValidationError(`Invalid mount option: ${opt}`);
          }
        }
      }

      // Validate credentials for CIFS (strict format check)
      if (request.credentials) {
        if (!request.credentials.username || !request.credentials.password) {
          throw new ValidationError('CIFS credentials require username and password');
        }
        // Use strict allowlist for credential fields that go into the credentials file
        // Username: alphanumeric, underscores, dots, hyphens (typical AD/CIFS usernames)
        const SAFE_USERNAME_PATTERN = /^[a-zA-Z0-9._\-@]+$/;
        // Domain: alphanumeric, dots, hyphens (typical domain names)
        const SAFE_DOMAIN_PATTERN = /^[a-zA-Z0-9.\-]+$/;

        if (!SAFE_USERNAME_PATTERN.test(request.credentials.username)) {
          throw new ValidationError('Invalid characters in CIFS username. Only alphanumeric and ._-@ are allowed.');
        }
        if (request.credentials.domain && !SAFE_DOMAIN_PATTERN.test(request.credentials.domain)) {
          throw new ValidationError('Invalid characters in CIFS domain. Only alphanumeric and .- are allowed.');
        }

        // SECURITY: Reject newlines and null bytes in password to prevent injection
        // These characters could allow injecting additional lines into the credentials file
        const DANGEROUS_CHARS = /[\n\r\0]/;
        if (DANGEROUS_CHARS.test(request.credentials.password)) {
          throw new ValidationError('CIFS password contains invalid characters (newlines or null bytes are not allowed)');
        }
      }
      break;
    }

    case 'umount': {
      // Validate mount point
      if (!MOUNT_POINT_PATTERN.test(request.mountPoint)) {
        throw new ValidationError(`Invalid mount point format: ${request.mountPoint}`);
      }
      if (request.mountPoint.includes('..')) {
        throw new ValidationError('Path traversal not allowed in mount point');
      }
      if (!ALLOWED_MOUNT_POINT_PREFIXES.some(p => request.mountPoint.startsWith(p))) {
        throw new ValidationError(`Mount point not in allowed prefix: ${request.mountPoint}`);
      }
      break;
    }

    case 'apt_install': {
      if (!Array.isArray(request.packages) || request.packages.length === 0) {
        throw new ValidationError('packages must be a non-empty array');
      }
      for (const pkg of request.packages) {
        if (!ALLOWED_APT_PACKAGES.has(pkg)) {
          throw new ValidationError(`Package not in allowlist: ${pkg}`);
        }
      }
      break;
    }

    case 'register_service': {
      // Validate service name matches allowed patterns
      if (!request.serviceName || typeof request.serviceName !== 'string') {
        throw new ValidationError('serviceName is required');
      }
      if (!ALLOWED_SERVICE_PATTERNS.some(p => p.test(request.serviceName))) {
        throw new ValidationError(`Invalid service name pattern: ${request.serviceName}`);
      }
      // Don't allow re-registering system services
      if (SYSTEM_SERVICES.has(request.serviceName)) {
        throw new ValidationError(`Cannot register system service: ${request.serviceName}`);
      }
      break;
    }

    case 'unregister_service': {
      if (!request.serviceName || typeof request.serviceName !== 'string') {
        throw new ValidationError('serviceName is required');
      }
      // Don't allow unregistering system services
      if (SYSTEM_SERVICES.has(request.serviceName)) {
        throw new ValidationError(`Cannot unregister system service: ${request.serviceName}`);
      }
      break;
    }

    default:
      throw new ValidationError(`Unknown action: ${(request as any).action}`);
  }
}
