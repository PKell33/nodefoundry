import { getDb } from '../db/index.js';
import logger from '../lib/logger.js';

/**
 * Audit event types for tracking system activities.
 */
export type AuditAction =
  // Deployment lifecycle
  | 'deployment_installed'
  | 'deployment_uninstalled'
  | 'deployment_started'
  | 'deployment_stopped'
  | 'deployment_restarted'
  | 'deployment_configured'
  | 'secrets_rotated'
  // Server management
  | 'server_registered'
  | 'server_deleted'
  | 'server_updated'
  // Agent tokens
  | 'agent_token_created'
  | 'agent_token_revoked'
  // User authentication
  | 'login'
  | 'login_failed'
  | 'user_login'  // Deprecated: use 'login'
  | 'user_logout'
  | 'password_changed'
  // Session management
  | 'session_revoked'
  | 'sessions_revoked'
  | 'sessions_cleanup'
  // User management
  | 'user_created'
  | 'user_deleted'
  | 'user_promoted_to_admin'
  | 'user_demoted_from_admin'
  | 'authorization_denied'
  // TOTP/2FA
  | 'totp_setup_started'
  | 'totp_enabled'
  | 'totp_disabled'
  | 'totp_backup_codes_regenerated'
  | 'totp_reset_by_admin'
  // Group management
  | 'group_created'
  | 'group_updated'
  | 'group_deleted'
  | 'user_added_to_group'
  | 'user_role_updated'
  | 'user_removed_from_group'
  // Backup and config
  | 'backup_created'
  | 'backup_restored'
  | 'backup_deleted'
  | 'config_exported'
  | 'config_imported'
  | 'state_recovery'
  | 'pending_commands_recovery'
  // Mount management
  | 'mount_created'
  | 'mount_updated'
  | 'mount_deleted'
  | 'server_mount_assigned'
  | 'server_mount_removed'
  | 'storage_mounted'
  | 'storage_unmounted'
  // Certificate management
  | 'certificate_issued'
  | 'certificate_renewed'
  | 'certificate_revoked'
  | 'ca_initialized'
  // Caddy HA
  | 'caddy_instance_registered'
  | 'caddy_instance_unregistered'
  | 'caddy_failover_triggered'
  | 'caddy_failover_completed'
  | 'caddy_primary_changed'
  | 'caddy_instance_health_changed'
  | 'caddy_config_synced'
  | 'caddy_vip_configured';

export type ResourceType = 'deployment' | 'server' | 'user' | 'auth' | 'system' | 'mount' | 'server_mount' | 'certificate' | 'session' | 'group' | 'caddy_ha';

export interface AuditEntry {
  action: AuditAction;
  resourceType: ResourceType;
  resourceId?: string;
  userId?: string;
  username?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

interface AuditLogRow {
  id: number;
  action: string;
  resource_type: string;
  resource_id: string | null;
  user_id: string | null;
  username: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
}

class AuditService {
  /**
   * Log an audit event.
   * This is designed to be fast and non-blocking.
   */
  log(entry: AuditEntry): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO audit_log (action, resource_type, resource_id, user_id, username, details, ip_address, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        entry.action,
        entry.resourceType,
        entry.resourceId || null,
        entry.userId || null,
        entry.username || null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.ipAddress || null
      );

      logger.debug({ action: entry.action, resourceId: entry.resourceId }, 'Audit event logged');
    } catch (err) {
      // Audit logging should never fail the main operation
      logger.error({ err, entry }, 'Failed to log audit event');
    }
  }

  /**
   * Query audit logs with optional filters.
   */
  query(filters: {
    action?: AuditAction;
    resourceType?: ResourceType;
    resourceId?: string;
    userId?: string;
    limit?: number;
    offset?: number;
  } = {}): {
    logs: Array<{
      id: number;
      action: AuditAction;
      resourceType: ResourceType;
      resourceId: string | null;
      userId: string | null;
      username: string | null;
      details: Record<string, unknown> | null;
      ipAddress: string | null;
      createdAt: Date;
    }>;
    total: number;
  } {
    const db = getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.action) {
      conditions.push('action = ?');
      params.push(filters.action);
    }
    if (filters.resourceType) {
      conditions.push('resource_type = ?');
      params.push(filters.resourceType);
    }
    if (filters.resourceId) {
      conditions.push('resource_id = ?');
      params.push(filters.resourceId);
    }
    if (filters.userId) {
      conditions.push('user_id = ?');
      params.push(filters.userId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countRow = db.prepare(`SELECT COUNT(*) as count FROM audit_log ${whereClause}`).get(...params) as { count: number };

    // Get paginated results
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    const rows = db.prepare(`
      SELECT * FROM audit_log ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as AuditLogRow[];

    return {
      logs: rows.map(row => ({
        id: row.id,
        action: row.action as AuditAction,
        resourceType: row.resource_type as ResourceType,
        resourceId: row.resource_id,
        userId: row.user_id,
        username: row.username,
        details: row.details ? JSON.parse(row.details) : null,
        ipAddress: row.ip_address,
        createdAt: new Date(row.created_at),
      })),
      total: countRow.count,
    };
  }
}

export const auditService = new AuditService();
