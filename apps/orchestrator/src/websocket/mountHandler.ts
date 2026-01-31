import type { Socket } from 'socket.io';
import { getDb } from '../db/index.js';
import { wsLogger } from '../lib/logger.js';
import { sendCommandWithResult } from './commandDispatcher.js';
import type { CommandResult, MountCommandPayload, MountCheckResult } from '@ownprem/shared';

// Type guard for MountCheckResult
export function isMountCheckResult(data: unknown): data is MountCheckResult {
  return typeof data === 'object' && data !== null && 'mounted' in data;
}

interface ServerMountRow {
  id: string;
  server_id: string;
  mount_id: string;
  mount_point: string;
  options: string | null;
  purpose: string | null;
  auto_mount: number;
  status: string;
  mount_type: string;
  source: string;
  default_options: string | null;
}

interface MountCredentialsRow {
  data: string;
}

/**
 * Send a mount-related command to an agent and wait for result.
 * Returns a promise that resolves with the command result.
 */
export function sendMountCommand(
  serverId: string,
  command: {
    id: string;
    action: 'mountStorage' | 'unmountStorage' | 'checkMount';
    appName: string;
    payload: { mountOptions: MountCommandPayload };
  },
  getAgentSocket: (serverId: string) => Socket | undefined
): Promise<CommandResult> {
  return sendCommandWithResult(serverId, command, getAgentSocket);
}

/**
 * Auto-mount storage for a server on agent connect.
 * Checks all server_mounts with auto_mount=true and mounts them if not already mounted.
 */
export async function autoMountServerStorage(
  serverId: string,
  getAgentSocket: (serverId: string) => Socket | undefined
): Promise<void> {
  const db = getDb();

  // Get all mounts for this server that should be auto-mounted
  const serverMounts = db.prepare(`
    SELECT sm.*, m.mount_type, m.source, m.default_options
    FROM server_mounts sm
    JOIN mounts m ON m.id = sm.mount_id
    WHERE sm.server_id = ? AND sm.auto_mount = TRUE
  `).all(serverId) as ServerMountRow[];

  if (serverMounts.length === 0) {
    return;
  }

  wsLogger.info({ serverId, mountCount: serverMounts.length }, 'Auto-mounting storage');

  for (const sm of serverMounts) {
    try {
      // First check if already mounted
      const checkId = `check-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const checkResult = await sendMountCommand(serverId, {
        id: checkId,
        action: 'checkMount',
        appName: 'storage',
        payload: {
          mountOptions: {
            mountType: sm.mount_type as 'nfs' | 'cifs',
            source: sm.source,
            mountPoint: sm.mount_point,
          },
        },
      }, getAgentSocket);

      if (checkResult.status === 'success' && isMountCheckResult(checkResult.data) && checkResult.data.mounted) {
        // Already mounted, update status and usage
        db.prepare(`
          UPDATE server_mounts
          SET status = 'mounted',
              usage_bytes = ?,
              total_bytes = ?,
              last_checked = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          checkResult.data.usage?.used ?? null,
          checkResult.data.usage?.total ?? null,
          sm.id
        );
        wsLogger.info({ serverId, mountPoint: sm.mount_point }, 'Mount already mounted');
        continue;
      }

      // Not mounted, need to mount
      db.prepare(`
        UPDATE server_mounts SET status = 'mounting', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(sm.id);

      // Get credentials for CIFS mounts
      let credentials: { username: string; password: string; domain?: string } | undefined;
      if (sm.mount_type === 'cifs') {
        const { secretsManager } = await import('../services/secretsManager.js');
        const credRow = db.prepare(`
          SELECT data FROM mount_credentials WHERE mount_id = ?
        `).get(sm.mount_id) as MountCredentialsRow | undefined;

        if (credRow) {
          credentials = secretsManager.decrypt(credRow.data) as typeof credentials;
        }
      }

      const mountId = `mount-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const mountResult = await sendMountCommand(serverId, {
        id: mountId,
        action: 'mountStorage',
        appName: 'storage',
        payload: {
          mountOptions: {
            mountType: sm.mount_type as 'nfs' | 'cifs',
            source: sm.source,
            mountPoint: sm.mount_point,
            options: sm.options || sm.default_options || undefined,
            credentials,
          },
        },
      }, getAgentSocket);

      if (mountResult.status === 'success') {
        db.prepare(`
          UPDATE server_mounts
          SET status = 'mounted',
              status_message = NULL,
              last_checked = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(sm.id);
        wsLogger.info({ serverId, mountPoint: sm.mount_point }, 'Mount successful');
      } else {
        db.prepare(`
          UPDATE server_mounts
          SET status = 'error',
              status_message = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(mountResult.message || 'Mount failed', sm.id);
        wsLogger.error({ serverId, mountPoint: sm.mount_point, error: mountResult.message }, 'Mount failed');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      db.prepare(`
        UPDATE server_mounts
        SET status = 'error',
            status_message = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(errorMessage, sm.id);
      wsLogger.error({ serverId, mountPoint: sm.mount_point, err }, 'Error auto-mounting storage');
    }
  }
}
