import { Router, Response } from 'express';
import { getDb } from '../../db/index.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { paginateQuery } from '../../lib/pagination.js';

const router = Router();

interface CommandLogRow {
  id: string;
  server_id: string;
  deployment_id: string | null;
  action: string;
  payload: string | null;
  status: string;
  result_message: string | null;
  created_at: string;
  completed_at: string | null;
}

/**
 * GET /api/commands
 * Query command history with optional filters.
 *
 * Query parameters:
 * - serverId: Filter by server
 * - deploymentId: Filter by deployment
 * - action: Filter by action (install, start, stop, etc.)
 * - status: Filter by status (pending, success, error, timeout)
 * - limit: Number of results (default 100)
 * - offset: Pagination offset (default 0)
 */
router.get('/', (req: AuthenticatedRequest, res: Response) => {
  const { serverId, deploymentId, action, status, limit, offset } = req.query;

  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (serverId) {
    conditions.push('cl.server_id = ?');
    params.push(serverId);
  }
  if (deploymentId) {
    conditions.push('cl.deployment_id = ?');
    params.push(deploymentId);
  }
  if (action) {
    conditions.push('cl.action = ?');
    params.push(action);
  }
  if (status) {
    conditions.push('cl.status = ?');
    params.push(status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count
  const countRow = db.prepare(`SELECT COUNT(*) as count FROM command_log cl ${whereClause}`).get(...params) as { count: number };

  // Get paginated results
  const queryLimit = Math.min(parseInt(limit as string) || 100, 500);
  const queryOffset = parseInt(offset as string) || 0;

  const rows = db.prepare(`
    SELECT cl.*, s.name as server_name, d.app_name
    FROM command_log cl
    LEFT JOIN servers s ON cl.server_id = s.id
    LEFT JOIN deployments d ON cl.deployment_id = d.id
    ${whereClause}
    ORDER BY cl.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, queryLimit, queryOffset) as (CommandLogRow & { server_name: string | null; app_name: string | null })[];

  const commands = rows.map(row => ({
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name,
    deploymentId: row.deployment_id,
    appName: row.app_name,
    action: row.action,
    payload: row.payload ? JSON.parse(row.payload) : null,
    status: row.status,
    resultMessage: row.result_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    duration: row.completed_at && row.created_at
      ? new Date(row.completed_at).getTime() - new Date(row.created_at).getTime()
      : null,
  }));

  res.json({
    data: commands,
    pagination: {
      total: countRow.count,
      limit: queryLimit,
      offset: queryOffset,
    },
  });
});

/**
 * GET /api/commands/:id
 * Get a specific command by ID.
 */
router.get('/:id', (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const db = getDb();

  const row = db.prepare(`
    SELECT cl.*, s.name as server_name, d.app_name
    FROM command_log cl
    LEFT JOIN servers s ON cl.server_id = s.id
    LEFT JOIN deployments d ON cl.deployment_id = d.id
    WHERE cl.id = ?
  `).get(id) as (CommandLogRow & { server_name: string | null; app_name: string | null }) | undefined;

  if (!row) {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Command not found',
      },
    });
    return;
  }

  res.json({
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name,
    deploymentId: row.deployment_id,
    appName: row.app_name,
    action: row.action,
    payload: row.payload ? JSON.parse(row.payload) : null,
    status: row.status,
    resultMessage: row.result_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    duration: row.completed_at && row.created_at
      ? new Date(row.completed_at).getTime() - new Date(row.created_at).getTime()
      : null,
  });
});

export default router;
