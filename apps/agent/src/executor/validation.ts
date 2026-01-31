/**
 * Input validation functions for the executor.
 * Prevents path traversal, command injection, and other attacks.
 */

import { normalize, resolve } from 'path';
import {
  OWNER_PATTERN,
  MODE_PATTERN,
  MOUNT_POINT_PATTERN,
  NFS_SOURCE_PATTERN,
  CIFS_SOURCE_PATTERN,
  ALLOWED_MOUNT_OPTIONS,
} from './executorTypes.js';

/**
 * Validates that a path is within allowed directories to prevent path traversal.
 */
export function validatePath(filePath: string, allowedPaths: string[]): string {
  // Normalize and resolve the path
  const normalizedPath = normalize(resolve(filePath));

  // Check if path is within allowed directories
  const isAllowed = allowedPaths.some(prefix =>
    normalizedPath.startsWith(prefix) || normalizedPath === prefix.slice(0, -1)
  );

  if (!isAllowed) {
    throw new Error(`Path traversal attempt blocked: ${filePath} is outside allowed directories`);
  }

  // Check for path traversal attempts in the original path
  if (filePath.includes('..')) {
    throw new Error(`Path traversal attempt blocked: ${filePath} contains '..'`);
  }

  return normalizedPath;
}

/**
 * Validates owner string format to prevent command injection.
 */
export function validateOwner(owner: string): string {
  if (!OWNER_PATTERN.test(owner)) {
    throw new Error(`Invalid owner format: ${owner}. Expected format: user or user:group`);
  }
  return owner;
}

/**
 * Validates file mode format.
 */
export function validateMode(mode: string): string {
  if (!MODE_PATTERN.test(mode)) {
    throw new Error(`Invalid file mode: ${mode}. Expected octal format (e.g., 755)`);
  }
  return mode;
}

/**
 * Validates mount point path.
 */
export function validateMountPoint(mountPoint: string): string {
  if (!MOUNT_POINT_PATTERN.test(mountPoint)) {
    throw new Error(`Invalid mount point: ${mountPoint}. Must be an absolute path with alphanumeric characters, underscores, and hyphens.`);
  }
  // Normalize to prevent path traversal
  const normalized = normalize(mountPoint);
  if (normalized !== mountPoint || mountPoint.includes('..')) {
    throw new Error(`Invalid mount point: path traversal attempt detected`);
  }
  return normalized;
}

/**
 * Validates NFS or CIFS source.
 */
export function validateMountSource(source: string, mountType: 'nfs' | 'cifs'): string {
  if (mountType === 'nfs') {
    if (!NFS_SOURCE_PATTERN.test(source)) {
      throw new Error(`Invalid NFS source: ${source}. Expected format: hostname:/path`);
    }
  } else if (mountType === 'cifs') {
    if (!CIFS_SOURCE_PATTERN.test(source)) {
      throw new Error(`Invalid CIFS source: ${source}. Expected format: //hostname/share`);
    }
  } else {
    throw new Error(`Unknown mount type: ${mountType}`);
  }
  return source;
}

/**
 * Validates mount options against whitelist.
 */
export function validateMountOptions(options: string): string {
  const opts = options.split(',').map(o => o.trim()).filter(o => o);
  const invalidOpts: string[] = [];

  for (const opt of opts) {
    // Check for exact match or pattern match for parameterized options
    const isValid = ALLOWED_MOUNT_OPTIONS.has(opt) ||
      // Allow uid/gid with any numeric value
      /^uid=\d+$/.test(opt) ||
      /^gid=\d+$/.test(opt) ||
      // Allow rsize/wsize with reasonable values
      /^rsize=\d+$/.test(opt) ||
      /^wsize=\d+$/.test(opt) ||
      // Allow timeo/retrans with reasonable values
      /^timeo=\d+$/.test(opt) ||
      /^retrans=\d+$/.test(opt) ||
      // Allow file_mode/dir_mode with octal values
      /^file_mode=0[0-7]{3}$/.test(opt) ||
      /^dir_mode=0[0-7]{3}$/.test(opt);

    if (!isValid) {
      invalidOpts.push(opt);
    }
  }

  if (invalidOpts.length > 0) {
    throw new Error(`Invalid mount options: ${invalidOpts.join(', ')}`);
  }

  return opts.join(',');
}
