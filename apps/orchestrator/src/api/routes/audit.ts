import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { requireAuth, requireSystemAdmin, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

interface AuditLogRow {
  id: number;
  timestamp: string;
  user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  ip_address: string | null;
  details: string | null;
  username?: string;
}

/**
 * GET /api/audit-logs
 * List audit log entries (system admin only)
 */
router.get('/', requireAuth, requireSystemAdmin, async (req: AuthenticatedRequest, res, next) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const action = req.query.action as string | undefined;

    let query = `
      SELECT
        al.*,
        u.username
      FROM audit_log al
      LEFT JOIN users u ON al.user_id = u.id
    `;
    const params: (string | number)[] = [];

    if (action) {
      query += ' WHERE al.action = ?';
      params.push(action);
    }

    query += ' ORDER BY al.timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params) as AuditLogRow[];

    // Get total count
    let countQuery = 'SELECT COUNT(*) as count FROM audit_log';
    if (action) {
      countQuery += ' WHERE action = ?';
    }
    const countResult = db.prepare(countQuery).get(...(action ? [action] : [])) as { count: number };

    const logs = rows.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      userId: row.user_id,
      username: row.username || null,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      ipAddress: row.ip_address,
      details: row.details ? JSON.parse(row.details) : null,
    }));

    res.json({
      logs,
      total: countResult.count,
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/audit-logs/actions
 * Get list of distinct actions for filtering
 */
router.get('/actions', requireAuth, requireSystemAdmin, async (_req, res, next) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all() as { action: string }[];
    res.json(rows.map(r => r.action));
  } catch (err) {
    next(err);
  }
});

export default router;
