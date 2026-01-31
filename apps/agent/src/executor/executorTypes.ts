/**
 * Type definitions and constants for the executor.
 */

import type { ChildProcess } from 'child_process';

// Allowed base directories for file operations
export const ALLOWED_PATH_PREFIXES = [
  '/opt/ownprem/',
  '/etc/ownprem/',
  '/var/lib/ownprem/',
  '/var/log/ownprem/',
  // System app paths (for CA and Caddy)
  '/etc/caddy/',
  '/etc/step-ca/',
  '/var/lib/caddy/',
  '/var/lib/step-ca/',
];

// Valid owner format: user or user:group (alphanumeric, underscore, hyphen)
export const OWNER_PATTERN = /^[a-z_][a-z0-9_-]*(?::[a-z_][a-z0-9_-]*)?$/i;

// Valid file mode (octal)
export const MODE_PATTERN = /^[0-7]{3,4}$/;

// Valid app name pattern (alphanumeric, hyphen, underscore, dots)
export const APP_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

// Maximum log lines to return
export const MAX_LOG_LINES = 1000;

// Script execution timeout (8 minutes - gives buffer before 10-minute command timeout)
export const SCRIPT_TIMEOUT_MS = 8 * 60 * 1000;

// Mount point validation: must be absolute path with allowed characters
export const MOUNT_POINT_PATTERN = /^\/[a-zA-Z0-9/_-]+$/;

// NFS source validation: host:/path
export const NFS_SOURCE_PATTERN = /^[a-zA-Z0-9.-]+:\/[a-zA-Z0-9/_-]+$/;

// CIFS source validation: //host/share
export const CIFS_SOURCE_PATTERN = /^\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_-]+$/;

// Allowed mount options whitelist
export const ALLOWED_MOUNT_OPTIONS = new Set([
  // NFS options
  'vers=3', 'vers=4', 'vers=4.0', 'vers=4.1', 'vers=4.2',
  'rw', 'ro', 'sync', 'async',
  'noatime', 'atime', 'nodiratime', 'relatime',
  'hard', 'soft', 'intr', 'nointr',
  'rsize=8192', 'rsize=16384', 'rsize=32768', 'rsize=65536', 'rsize=131072', 'rsize=262144', 'rsize=524288', 'rsize=1048576',
  'wsize=8192', 'wsize=16384', 'wsize=32768', 'wsize=65536', 'wsize=131072', 'wsize=262144', 'wsize=524288', 'wsize=1048576',
  'timeo=60', 'timeo=120', 'timeo=300', 'timeo=600',
  'retrans=2', 'retrans=3', 'retrans=5',
  'tcp', 'udp',
  'nfsvers=3', 'nfsvers=4', 'nfsvers=4.0', 'nfsvers=4.1', 'nfsvers=4.2',
  // CIFS options
  'uid=1000', 'gid=1000', 'uid=0', 'gid=0',
  'file_mode=0755', 'file_mode=0644', 'dir_mode=0755', 'dir_mode=0644',
  'nobrl', 'nolock', 'noperm',
  'sec=ntlm', 'sec=ntlmv2', 'sec=ntlmssp', 'sec=krb5', 'sec=krb5i', 'sec=none',
  'iocharset=utf8',
  // Common options
  'defaults', 'noexec', 'nosuid', 'nodev',
]);

// State tracking
export interface ExecutorState {
  runningProcesses: Map<string, ChildProcess>;
  activeLogStreams: Map<string, ChildProcess>;
  appsDir: string;
  dataDir: string;
  allowedPaths: string[];
}
