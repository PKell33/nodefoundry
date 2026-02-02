import { Router, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { getDb } from '../../db/index.js';
import { ServerRow, rowToServer } from '../../db/types.js';
import { update } from '../../db/queryBuilder.js';
import { Errors, createTypedError } from '../middleware/error.js';
import { validateBody, validateParams, schemas } from '../middleware/validate.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { hashToken } from '../../websocket/agentHandler.js';
import { parsePaginationParams, paginateOrReturnAll } from '../../lib/pagination.js';
import { ErrorCodes } from '@ownprem/shared';

// Helper: Check if user can manage servers (system admin only for now)
function canManageServers(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: { code: ErrorCodes.UNAUTHORIZED, message: 'Authentication required' } });
    return;
  }
  if (req.user.isSystemAdmin) {
    next();
    return;
  }
  res.status(403).json({ error: { code: ErrorCodes.FORBIDDEN, message: 'System admin permission required' } });
}

const router = Router();

// GET /api/servers - List all servers
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM servers ORDER BY is_core DESC, name').all() as ServerRow[];
  const servers = rows.map(rowToServer);

  // Apply pagination if requested, otherwise return full array for backward compatibility
  const paginationParams = parsePaginationParams(req);
  res.json(paginateOrReturnAll(servers, paginationParams));
});

// POST /api/servers - Add a new server (system admin only)
router.post('/', requireAuth, canManageServers, validateBody(schemas.servers.create), (req, res) => {
  const { name, host } = req.body;
  const db = getDb();
  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // Generate and hash the auth token
  const rawAuthToken = randomBytes(32).toString('hex');
  const hashedAuthToken = hashToken(rawAuthToken);

  const existing = db.prepare('SELECT id FROM servers WHERE id = ? OR name = ?').get(id, name);
  if (existing) {
    throw createTypedError(ErrorCodes.SERVER_EXISTS, 'Server with this name already exists');
  }

  // Store the hashed token in the database
  const stmt = db.prepare(`
    INSERT INTO servers (id, name, host, is_core, auth_token, agent_status)
    VALUES (?, ?, ?, FALSE, ?, 'offline')
  `);
  stmt.run(id, name, host, hashedAuthToken);

  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as ServerRow;
  const server = rowToServer(row);

  // Return bootstrap command for the new server (using raw token, not hashed)
  const bootstrapCommand = `curl -sSL http://${req.get('host')}/agent/install.sh | sudo bash -s -- --orchestrator http://${req.get('host')} --token ${rawAuthToken} --id ${id}`;

  res.status(201).json({
    server,
    bootstrapCommand,
  });
});

// GET /api/servers/:id - Get server details
router.get('/:id', requireAuth, validateParams(schemas.serverIdParam), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as ServerRow | undefined;

  if (!row) {
    throw Errors.serverNotFound(req.params.id);
  }

  res.json(rowToServer(row));
});

// PUT /api/servers/:id - Update server (system admin only)
router.put('/:id', requireAuth, canManageServers, validateParams(schemas.serverIdParam), validateBody(schemas.servers.update), (req, res) => {
  const { name, host } = req.body;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as ServerRow | undefined;
  if (!existing) {
    throw Errors.serverNotFound(req.params.id);
  }

  if (existing.is_core) {
    throw createTypedError(ErrorCodes.CANNOT_MODIFY_CORE, 'Cannot modify core server');
  }

  // Build UPDATE using UpdateBuilder
  const { setClause, params, hasUpdates } = update()
    .set('name', name)
    .set('host', host)
    .setRaw('updated_at', 'CURRENT_TIMESTAMP')
    .build();

  if (!hasUpdates) {
    throw Errors.validation('No fields to update');
  }

  db.prepare(`UPDATE servers SET ${setClause} WHERE id = ?`).run(...params, req.params.id);

  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as ServerRow;
  res.json(rowToServer(row));
});

// DELETE /api/servers/:id - Remove server (system admin only)
router.delete('/:id', requireAuth, canManageServers, validateParams(schemas.serverIdParam), (req, res) => {
  const db = getDb();

  const existing = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as ServerRow | undefined;
  if (!existing) {
    throw Errors.serverNotFound(req.params.id);
  }

  if (existing.is_core) {
    throw createTypedError(ErrorCodes.CANNOT_DELETE_CORE, 'Cannot delete core server');
  }

  db.prepare('DELETE FROM servers WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// POST /api/servers/:id/regenerate-token - Regenerate auth token (system admin only)
router.post('/:id/regenerate-token', requireAuth, canManageServers, validateParams(schemas.serverIdParam), (req, res) => {
  const db = getDb();

  const existing = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as ServerRow | undefined;
  if (!existing) {
    throw Errors.serverNotFound(req.params.id);
  }

  if (existing.is_core) {
    throw createTypedError(ErrorCodes.CANNOT_MODIFY_CORE, 'Cannot regenerate token for core server');
  }

  // Generate new token
  const rawAuthToken = randomBytes(32).toString('hex');
  const hashedAuthToken = hashToken(rawAuthToken);

  // Update the token in database
  db.prepare(`
    UPDATE servers SET auth_token = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(hashedAuthToken, req.params.id);

  // Return bootstrap command with the new token
  const bootstrapCommand = `curl -sSL http://${req.get('host')}/agent/install.sh | sudo bash -s -- --orchestrator http://${req.get('host')} --token ${rawAuthToken} --id ${req.params.id}`;

  res.json({
    server: rowToServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as ServerRow),
    bootstrapCommand,
  });
});

// ==================
// Agent Token Management
// ==================

// GET /api/servers/:id/tokens - List all tokens for a server
router.get('/:id/tokens', requireAuth, canManageServers, validateParams(schemas.serverIdParam), async (req: AuthenticatedRequest, res, next) => {
  try {
    const db = getDb();

    // Verify server exists
    const existing = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
    if (!existing) {
      throw Errors.serverNotFound(req.params.id);
    }

    const { agentTokenService } = await import('../../services/agentTokenService.js');
    const tokens = agentTokenService.listTokens(req.params.id);

    res.json(tokens);
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/tokens - Create a new token for a server
router.post('/:id/tokens', requireAuth, canManageServers, validateParams(schemas.serverIdParam), validateBody(schemas.agentTokens.create), async (req: AuthenticatedRequest, res, next) => {
  try {
    const db = getDb();

    // Verify server exists
    const existing = db.prepare('SELECT id, is_core FROM servers WHERE id = ?').get(req.params.id) as { id: string; is_core: number } | undefined;
    if (!existing) {
      throw Errors.serverNotFound(req.params.id);
    }

    if (existing.is_core) {
      throw createTypedError(ErrorCodes.CANNOT_MODIFY_CORE, 'Cannot create tokens for core server');
    }

    const { agentTokenService } = await import('../../services/agentTokenService.js');
    const { name, expiresIn } = req.body;

    const result = agentTokenService.createToken(
      req.params.id,
      { name, expiresIn },
      req.user?.userId
    );

    // Return token info with raw token (only visible once)
    res.status(201).json({
      token: result.token,
      rawToken: result.rawToken,
      message: 'Token created successfully. Save the raw token now - it will not be shown again.',
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/servers/:id/tokens/:tokenId - Revoke a specific token
router.delete('/:id/tokens/:tokenId', requireAuth, canManageServers, validateParams(schemas.serverTokenParams), async (req: AuthenticatedRequest, res, next) => {
  try {
    const db = getDb();

    // Verify server exists
    const existing = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
    if (!existing) {
      throw Errors.serverNotFound(req.params.id);
    }

    const { agentTokenService } = await import('../../services/agentTokenService.js');
    const revoked = agentTokenService.revokeToken(
      req.params.tokenId,
      req.params.id,
      req.user?.userId
    );

    if (!revoked) {
      throw Errors.notFound('Token', req.params.tokenId);
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
