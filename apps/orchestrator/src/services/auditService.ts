import { getDb } from '../db/index.js';
import logger from '../lib/logger.js';

/**
 * Audit event types for tracking system activities.
 */
export type AuditAction =
  | 'deployment_installed'
  | 'deployment_uninstalled'
  | 'deployment_started'
  | 'deployment_stopped'
  | 'deployment_restarted'
  | 'deployment_configured'
  | 'server_registered'
  | 'server_deleted'
  | 'server_updated'
  | 'user_login'
  | 'user_logout'
  | 'user_created'
  | 'authorization_denied'
  | 'totp_enabled'
  | 'totp_disabled';

export type ResourceType = 'deployment' | 'server' | 'user' | 'auth';

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
