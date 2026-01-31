/**
 * Mount/unmount operations for network storage.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import type { MountCommandPayload, MountCheckResult } from '@ownprem/shared';
import { privilegedClient } from '../privilegedClient.js';
import { validateMountPoint, validateMountSource, validateMountOptions } from './validation.js';
import logger from '../lib/logger.js';

const mountLogger = logger.child({ component: 'mountManager' });

/**
 * Mount network storage (NFS or CIFS).
 */
export async function mountStorage(payload: MountCommandPayload): Promise<void> {
  const { mountType, source, mountPoint, options, credentials } = payload;

  // Validate inputs (agent-side validation for early feedback)
  const safeMountPoint = validateMountPoint(mountPoint);
  const safeSource = validateMountSource(source, mountType);
  const safeOptions = options ? validateMountOptions(options) : undefined;

  // Check if already mounted
  const checkResult = await checkMount(safeMountPoint);
  if (checkResult.mounted) {
    mountLogger.info(`Already mounted: ${safeMountPoint}`);
    return;
  }

  mountLogger.info(`Mounting ${mountType.toUpperCase()}: ${safeSource} -> ${safeMountPoint}`);

  // Use privileged helper for mount operation
  try {
    const result = await privilegedClient.mount(
      mountType,
      safeSource,
      safeMountPoint,
      safeOptions,
      credentials
    );

    if (!result.success) {
      throw new Error(`Mount failed: ${result.error}`);
    }

    mountLogger.info(`Successfully mounted: ${safeMountPoint}`);
  } catch (err) {
    // Privileged helper not available, try direct mount (requires root)
    mountLogger.warn(`Privileged helper failed, attempting direct mount: ${err}`);
    await mountStorageDirect(payload);
  }
}

/**
 * Direct mount (fallback when privileged helper is unavailable).
 */
async function mountStorageDirect(payload: MountCommandPayload): Promise<void> {
  const { mountType, source, mountPoint, options, credentials } = payload;

  const safeMountPoint = validateMountPoint(mountPoint);
  const safeSource = validateMountSource(source, mountType);
  const safeOptions = options ? validateMountOptions(options) : null;

  // Create mount point directory if it doesn't exist
  if (!existsSync(safeMountPoint)) {
    mkdirSync(safeMountPoint, { recursive: true });
    mountLogger.info(`Created mount point: ${safeMountPoint}`);
  }

  // Build mount command args
  const args: string[] = ['-t', mountType];

  if (mountType === 'cifs' && credentials) {
    // Create a secure temporary directory with restricted permissions
    let credDir: string | null = null;
    let credFile: string | null = null;

    try {
      // Create temp directory in /run (tmpfs, not persisted to disk)
      const tempBase = existsSync('/run') ? '/run' : tmpdir();
      credDir = mkdtempSync(`${tempBase}/ownprem-mount-`);
      credFile = `${credDir}/credentials`;

      // Write credentials with strict permissions (owner read only)
      let credContent = `username=${credentials.username}\npassword=${credentials.password}\n`;
      if (credentials.domain) {
        credContent += `domain=${credentials.domain}\n`;
      }
      writeFileSync(credFile, credContent, { mode: 0o400 });

      const credOptions = `credentials=${credFile}`;
      const allOptions = safeOptions ? `${credOptions},${safeOptions}` : credOptions;
      args.push('-o', allOptions);
      args.push(safeSource, safeMountPoint);

      const result = spawnSync('mount', args, {
        encoding: 'utf-8',
        timeout: 30000,
      });

      if (result.status !== 0) {
        throw new Error(`Mount failed: ${result.stderr || 'Unknown error'}`);
      }
    } finally {
      // Always clean up credentials - this runs even if mount throws
      if (credFile) {
        try {
          // Overwrite file content before deletion to prevent recovery
          writeFileSync(credFile, '0'.repeat(256), { mode: 0o400 });
          unlinkSync(credFile);
        } catch {
          mountLogger.warn('Failed to clean up credential file');
        }
      }
      if (credDir) {
        try {
          rmdirSync(credDir);
        } catch {
          // Directory removal is best effort
        }
      }
    }
  } else {
    // NFS or CIFS without credentials
    if (safeOptions) {
      args.push('-o', safeOptions);
    }
    args.push(safeSource, safeMountPoint);

    const result = spawnSync('mount', args, {
      encoding: 'utf-8',
      timeout: 30000,
    });

    if (result.status !== 0) {
      throw new Error(`Mount failed: ${result.stderr || 'Unknown error'}`);
    }
  }

  mountLogger.info(`Successfully mounted: ${safeMountPoint}`);
}

/**
 * Unmount network storage.
 */
export async function unmountStorage(mountPoint: string): Promise<void> {
  const safeMountPoint = validateMountPoint(mountPoint);

  // Check if mounted
  const checkResult = await checkMount(safeMountPoint);
  if (!checkResult.mounted) {
    mountLogger.info(`Not mounted: ${safeMountPoint}`);
    return;
  }

  mountLogger.info(`Unmounting: ${safeMountPoint}`);

  // Use privileged helper for unmount operation
  try {
    const result = await privilegedClient.umount(safeMountPoint);

    if (!result.success) {
      throw new Error(`Unmount failed: ${result.error}`);
    }

    mountLogger.info(`Successfully unmounted: ${safeMountPoint}`);
  } catch (err) {
    // Privileged helper not available, try direct umount (requires root)
    mountLogger.warn(`Privileged helper failed, attempting direct unmount: ${err}`);

    const result = spawnSync('umount', [safeMountPoint], {
      encoding: 'utf-8',
      timeout: 30000,
    });

    if (result.status !== 0) {
      throw new Error(`Unmount failed: ${result.stderr || 'Unknown error'}`);
    }

    mountLogger.info(`Successfully unmounted: ${safeMountPoint}`);
  }
}

/**
 * Check if a mount point is mounted and get usage stats.
 */
export async function checkMount(mountPoint: string): Promise<MountCheckResult> {
  const safeMountPoint = validateMountPoint(mountPoint);

  // Use findmnt to check if mounted
  const findmntResult = spawnSync('findmnt', ['-n', safeMountPoint], {
    encoding: 'utf-8',
    timeout: 5000,
  });

  const mounted = findmntResult.status === 0 && findmntResult.stdout.trim().length > 0;

  if (!mounted) {
    return { mounted: false };
  }

  // Get usage stats with df
  const dfResult = spawnSync('df', ['-B1', safeMountPoint], {
    encoding: 'utf-8',
    timeout: 5000,
  });

  if (dfResult.status !== 0) {
    return { mounted: true };
  }

  // Parse df output
  // Format: Filesystem 1B-blocks Used Available Use% Mounted on
  const lines = dfResult.stdout.trim().split('\n');
  if (lines.length < 2) {
    return { mounted: true };
  }

  const parts = lines[1].split(/\s+/);
  if (parts.length < 4) {
    return { mounted: true };
  }

  const total = parseInt(parts[1], 10);
  const used = parseInt(parts[2], 10);

  if (isNaN(total) || isNaN(used)) {
    return { mounted: true };
  }

  return {
    mounted: true,
    usage: { used, total },
  };
}
