import { Router, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/index.js';
import { createError } from '../middleware/error.js';
import { validateBody, validateParams, schemas } from '../middleware/validate.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { auditService } from '../../services/auditService.js';
import { secretsManager } from '../../services/secretsManager.js';
import { sendMountCommand, isAgentConnected } from '../../websocket/agentHandler.js';
import { apiLogger } from '../../lib/logger.js';
import type { Mount, ServerMount, ServerMountWithDetails, MountType, MountStatus } from '@ownprem/shared';

const router = Router();

// Helper: Check if user can manage mounts (system admin only)
function canManageMounts(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    return;
  }
  if (req.user.isSystemAdmin) {
    next();
    return;
  }
  res.status(403).json({ error: { code: 'FORBIDDEN', message: 'System admin permission required' } });
}

// ==================
// Type definitions
// ==================

interface MountRow {
  id: string;
  name: string;
  mount_type: string;
  source: string;
  default_options: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
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
  status_message: string | null;
  last_checked: string | null;
  usage_bytes: number | null;
  total_bytes: number | null;
  created_at: string;
  updated_at: string;
}

interface ServerMountWithDetailsRow extends ServerMountRow {
  mount_name: string;
  mount_type: string;
  source: string;
  default_options: string | null;
  mount_description: string | null;
  server_name: string;
  has_credentials: number;
}

function rowToMount(row: MountRow, hasCredentials: boolean = false): Mount {
  return {
    id: row.id,
    name: row.name,
    mountType: row.mount_type as MountType,
    source: row.source,
    defaultOptions: row.default_options,
    hasCredentials,
    description: row.description,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToServerMount(row: ServerMountRow): ServerMount {
  return {
    id: row.id,
    serverId: row.server_id,
    mountId: row.mount_id,
    mountPoint: row.mount_point,
    options: row.options,
    purpose: row.purpose,
    autoMount: Boolean(row.auto_mount),
    status: row.status as MountStatus,
    statusMessage: row.status_message,
    lastChecked: row.last_checked ? new Date(row.last_checked) : null,
    usageBytes: row.usage_bytes,
    totalBytes: row.total_bytes,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToServerMountWithDetails(row: ServerMountWithDetailsRow): ServerMountWithDetails {
  return {
    ...rowToServerMount(row),
    mount: {
      id: row.mount_id,
      name: row.mount_name,
      mountType: row.mount_type as MountType,
      source: row.source,
      defaultOptions: row.default_options,
      hasCredentials: Boolean(row.has_credentials),
      description: row.mount_description,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    },
    serverName: row.server_name,
  };
}

// ==================
// Mount Definition Routes
// ==================

// GET /api/mounts - List all mount definitions
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT m.*,
             CASE WHEN mc.id IS NOT NULL THEN 1 ELSE 0 END as has_credentials
      FROM mounts m
      LEFT JOIN mount_credentials mc ON mc.mount_id = m.id
      ORDER BY m.name
    `).all() as (MountRow & { has_credentials: number })[];

    const mounts = rows.map(row => rowToMount(row, Boolean(row.has_credentials)));
    res.json(mounts);
  } catch (err) {
    next(err);
  }
});

// POST /api/mounts - Create a new mount definition
router.post('/', requireAuth, canManageMounts, validateBody(schemas.mounts.create), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { name, mountType, source, defaultOptions, description, credentials } = req.body;
    const db = getDb();

    // Check for existing mount with same name
    const existing = db.prepare('SELECT id FROM mounts WHERE name = ?').get(name);
    if (existing) {
      throw createError('Mount with this name already exists', 409, 'MOUNT_EXISTS');
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO mounts (id, name, mount_type, source, default_options, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, mountType, source, defaultOptions || null, description || null);

    // Store credentials if provided (for CIFS mounts)
    if (credentials && mountType === 'cifs') {
      const encrypted = secretsManager.encrypt(credentials);
      db.prepare(`
        INSERT INTO mount_credentials (id, mount_id, data)
        VALUES (?, ?, ?)
      `).run(randomUUID(), id, encrypted);
    }

    auditService.log({
      userId: req.user?.userId,
      action: 'mount_created',
      resourceType: 'mount',
      resourceId: id,
      details: { name, mountType, source },
    });

    const row = db.prepare('SELECT * FROM mounts WHERE id = ?').get(id) as MountRow;
    res.status(201).json(rowToMount(row, !!credentials));
  } catch (err) {
    next(err);
  }
});

// ==================
// Server Mount Assignment Routes
// NOTE: These routes MUST come before /:id routes to avoid /servers being matched as an ID
// ==================

// GET /api/mounts/servers - List all server mount assignments
router.get('/servers', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT sm.*,
             m.name as mount_name,
             m.mount_type,
             m.source,
             m.default_options,
             m.description as mount_description,
             s.name as server_name,
             CASE WHEN mc.id IS NOT NULL THEN 1 ELSE 0 END as has_credentials
      FROM server_mounts sm
      JOIN mounts m ON m.id = sm.mount_id
      JOIN servers s ON s.id = sm.server_id
      LEFT JOIN mount_credentials mc ON mc.mount_id = m.id
      ORDER BY s.name, sm.mount_point
    `).all() as ServerMountWithDetailsRow[];

    const serverMounts = rows.map(rowToServerMountWithDetails);
    res.json(serverMounts);
  } catch (err) {
    next(err);
  }
});

// POST /api/mounts/servers - Assign mount to server
router.post('/servers', requireAuth, canManageMounts, validateBody(schemas.mounts.assignToServer), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { serverId, mountId, mountPoint, options, purpose, autoMount } = req.body;
    const db = getDb();

    // Verify server exists
    const server = db.prepare('SELECT id, name FROM servers WHERE id = ?').get(serverId) as { id: string; name: string } | undefined;
    if (!server) {
      throw createError('Server not found', 404, 'SERVER_NOT_FOUND');
    }

    // Verify mount exists
    const mount = db.prepare('SELECT id, name FROM mounts WHERE id = ?').get(mountId) as { id: string; name: string } | undefined;
    if (!mount) {
      throw createError('Mount not found', 404, 'MOUNT_NOT_FOUND');
    }

    // Check for existing assignment with same mount point
    const existingMount = db.prepare(`
      SELECT id FROM server_mounts WHERE server_id = ? AND mount_point = ?
    `).get(serverId, mountPoint);
    if (existingMount) {
      throw createError('Mount point already in use on this server', 409, 'MOUNT_POINT_EXISTS');
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO server_mounts (id, server_id, mount_id, mount_point, options, purpose, auto_mount, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, serverId, mountId, mountPoint, options || null, purpose || null, autoMount !== false ? 1 : 0);

    auditService.log({
      userId: req.user?.userId,
      action: 'server_mount_assigned',
      resourceType: 'server_mount',
      resourceId: id,
      details: { serverId, mountId, mountPoint, serverName: server.name, mountName: mount.name },
    });

    const row = db.prepare(`
      SELECT sm.*,
             m.name as mount_name,
             m.mount_type,
             m.source,
             m.default_options,
             m.description as mount_description,
             s.name as server_name,
             CASE WHEN mc.id IS NOT NULL THEN 1 ELSE 0 END as has_credentials
      FROM server_mounts sm
      JOIN mounts m ON m.id = sm.mount_id
      JOIN servers s ON s.id = sm.server_id
      LEFT JOIN mount_credentials mc ON mc.mount_id = m.id
      WHERE sm.id = ?
    `).get(id) as ServerMountWithDetailsRow;

    res.status(201).json(rowToServerMountWithDetails(row));
  } catch (err) {
    next(err);
  }
});

// POST /api/mounts/servers/:id/mount - Mount storage on server
router.post('/servers/:id/mount', requireAuth, canManageMounts, validateParams(schemas.idParam), async (req: AuthenticatedRequest, res, next) => {
  try {
    const db = getDb();

    const row = db.prepare(`
      SELECT sm.*, m.mount_type, m.source, m.default_options, s.name as server_name
      FROM server_mounts sm
      JOIN mounts m ON m.id = sm.mount_id
      JOIN servers s ON s.id = sm.server_id
      WHERE sm.id = ?
    `).get(req.params.id) as (ServerMountRow & { mount_type: string; source: string; default_options: string | null; server_name: string }) | undefined;

    if (!row) {
      throw createError('Server mount not found', 404, 'SERVER_MOUNT_NOT_FOUND');
    }

    // Check if agent is connected
    if (!isAgentConnected(row.server_id)) {
      throw createError('Agent is not connected', 503, 'AGENT_NOT_CONNECTED');
    }

    // Update status to mounting
    db.prepare(`
      UPDATE server_mounts SET status = 'mounting', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id);

    // Get credentials for CIFS mounts
    let credentials: { username: string; password: string; domain?: string } | undefined;
    if (row.mount_type === 'cifs') {
      const credRow = db.prepare('SELECT data FROM mount_credentials WHERE mount_id = ?')
        .get(row.mount_id) as { data: string } | undefined;
      if (credRow) {
        credentials = secretsManager.decrypt(credRow.data) as typeof credentials;
      }
    }

    // Send mount command
    const commandId = `mount-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    try {
      const result = await sendMountCommand(row.server_id, {
        id: commandId,
        action: 'mountStorage',
        appName: 'storage',
        payload: {
          mountOptions: {
            mountType: row.mount_type as 'nfs' | 'cifs',
            source: row.source,
            mountPoint: row.mount_point,
            options: row.options || row.default_options || undefined,
            credentials,
          },
        },
      });

      if (result.status === 'success') {
        db.prepare(`
          UPDATE server_mounts
          SET status = 'mounted', status_message = NULL, last_checked = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(req.params.id);

        auditService.log({
          userId: req.user?.userId,
          action: 'storage_mounted',
          resourceType: 'server_mount',
          resourceId: req.params.id,
          details: { serverId: row.server_id, mountPoint: row.mount_point },
        });
      } else {
        db.prepare(`
          UPDATE server_mounts
          SET status = 'error', status_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(result.message || 'Mount failed', req.params.id);
      }

      const updatedRow = db.prepare(`
        SELECT sm.*,
               m.name as mount_name,
               m.mount_type,
               m.source,
               m.default_options,
               m.description as mount_description,
               s.name as server_name,
               CASE WHEN mc.id IS NOT NULL THEN 1 ELSE 0 END as has_credentials
        FROM server_mounts sm
        JOIN mounts m ON m.id = sm.mount_id
        JOIN servers s ON s.id = sm.server_id
        LEFT JOIN mount_credentials mc ON mc.mount_id = m.id
        WHERE sm.id = ?
      `).get(req.params.id) as ServerMountWithDetailsRow;

      res.json(rowToServerMountWithDetails(updatedRow));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Log full error for debugging, but don't expose internal details to client
      apiLogger.error({ err, serverMountId: req.params.id }, 'Mount operation failed');
      db.prepare(`
        UPDATE server_mounts
        SET status = 'error', status_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(errorMessage, req.params.id);
      throw createError('Mount operation failed. Check server logs for details.', 500, 'MOUNT_FAILED');
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/mounts/servers/:id/unmount - Unmount storage from server
router.post('/servers/:id/unmount', requireAuth, canManageMounts, validateParams(schemas.idParam), async (req: AuthenticatedRequest, res, next) => {
  try {
    const db = getDb();

    const row = db.prepare(`
      SELECT sm.*, m.mount_type, m.source, s.name as server_name
      FROM server_mounts sm
      JOIN mounts m ON m.id = sm.mount_id
      JOIN servers s ON s.id = sm.server_id
      WHERE sm.id = ?
    `).get(req.params.id) as (ServerMountRow & { mount_type: string; source: string; server_name: string }) | undefined;

    if (!row) {
      throw createError('Server mount not found', 404, 'SERVER_MOUNT_NOT_FOUND');
    }

    // Check if agent is connected
    if (!isAgentConnected(row.server_id)) {
      throw createError('Agent is not connected', 503, 'AGENT_NOT_CONNECTED');
    }

    // Send unmount command
    const commandId = `unmount-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    try {
      const result = await sendMountCommand(row.server_id, {
        id: commandId,
        action: 'unmountStorage',
        appName: 'storage',
        payload: {
          mountOptions: {
            mountType: row.mount_type as 'nfs' | 'cifs',
            source: row.source,
            mountPoint: row.mount_point,
          },
        },
      });

      if (result.status === 'success') {
        db.prepare(`
          UPDATE server_mounts
          SET status = 'unmounted',
              status_message = NULL,
              usage_bytes = NULL,
              total_bytes = NULL,
              last_checked = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(req.params.id);

        auditService.log({
          userId: req.user?.userId,
          action: 'storage_unmounted',
          resourceType: 'server_mount',
          resourceId: req.params.id,
          details: { serverId: row.server_id, mountPoint: row.mount_point },
        });
      } else {
        db.prepare(`
          UPDATE server_mounts
          SET status = 'error', status_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(result.message || 'Unmount failed', req.params.id);
      }

      const updatedRow = db.prepare(`
        SELECT sm.*,
               m.name as mount_name,
               m.mount_type,
               m.source,
               m.default_options,
               m.description as mount_description,
               s.name as server_name,
               CASE WHEN mc.id IS NOT NULL THEN 1 ELSE 0 END as has_credentials
        FROM server_mounts sm
        JOIN mounts m ON m.id = sm.mount_id
        JOIN servers s ON s.id = sm.server_id
        LEFT JOIN mount_credentials mc ON mc.mount_id = m.id
        WHERE sm.id = ?
      `).get(req.params.id) as ServerMountWithDetailsRow;

      res.json(rowToServerMountWithDetails(updatedRow));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Log full error for debugging, but don't expose internal details to client
      apiLogger.error({ err, serverMountId: req.params.id }, 'Unmount operation failed');
      db.prepare(`
        UPDATE server_mounts
        SET status = 'error', status_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(errorMessage, req.params.id);
      throw createError('Unmount operation failed. Check server logs for details.', 500, 'UNMOUNT_FAILED');
    }
  } catch (err) {
    next(err);
  }
});

// DELETE /api/mounts/servers/:id - Remove server mount assignment
router.delete('/servers/:id', requireAuth, canManageMounts, validateParams(schemas.idParam), async (req: AuthenticatedRequest, res, next) => {
  try {
    const db = getDb();

    const row = db.prepare(`
      SELECT sm.*, s.name as server_name
      FROM server_mounts sm
      JOIN servers s ON s.id = sm.server_id
      WHERE sm.id = ?
    `).get(req.params.id) as (ServerMountRow & { server_name: string }) | undefined;

    if (!row) {
      throw createError('Server mount not found', 404, 'SERVER_MOUNT_NOT_FOUND');
    }

    // Don't allow deletion if mounted
    if (row.status === 'mounted' || row.status === 'mounting') {
      throw createError('Cannot delete mounted storage. Unmount first.', 400, 'MOUNT_ACTIVE');
    }

    db.prepare('DELETE FROM server_mounts WHERE id = ?').run(req.params.id);

    auditService.log({
      userId: req.user?.userId,
      action: 'server_mount_removed',
      resourceType: 'server_mount',
      resourceId: req.params.id,
      details: { serverId: row.server_id, mountPoint: row.mount_point, serverName: row.server_name },
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ==================
// Mount Detail Routes (parametric :id routes must come AFTER literal routes)
// ==================

// GET /api/mounts/:id - Get mount details
router.get('/:id', requireAuth, validateParams(schemas.idParam), async (req, res, next) => {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT m.*,
             CASE WHEN mc.id IS NOT NULL THEN 1 ELSE 0 END as has_credentials
      FROM mounts m
      LEFT JOIN mount_credentials mc ON mc.mount_id = m.id
      WHERE m.id = ?
    `).get(req.params.id) as (MountRow & { has_credentials: number }) | undefined;

    if (!row) {
      throw createError('Mount not found', 404, 'MOUNT_NOT_FOUND');
    }

    res.json(rowToMount(row, Boolean(row.has_credentials)));
  } catch (err) {
    next(err);
  }
});

// PUT /api/mounts/:id - Update mount definition
router.put('/:id', requireAuth, canManageMounts, validateParams(schemas.idParam), validateBody(schemas.mounts.update), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { name, source, defaultOptions, description, credentials } = req.body;
    const db = getDb();

    const existing = db.prepare('SELECT * FROM mounts WHERE id = ?').get(req.params.id) as MountRow | undefined;
    if (!existing) {
      throw createError('Mount not found', 404, 'MOUNT_NOT_FOUND');
    }

    // Check for name conflict
    if (name && name !== existing.name) {
      const conflict = db.prepare('SELECT id FROM mounts WHERE name = ? AND id != ?').get(name, req.params.id);
      if (conflict) {
        throw createError('Mount with this name already exists', 409, 'MOUNT_EXISTS');
      }
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (source !== undefined) {
      updates.push('source = ?');
      values.push(source);
    }
    if (defaultOptions !== undefined) {
      updates.push('default_options = ?');
      values.push(defaultOptions || null);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description || null);
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(req.params.id);
      db.prepare(`UPDATE mounts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    // Update credentials if provided
    if (credentials !== undefined) {
      if (credentials) {
        const encrypted = secretsManager.encrypt(credentials);
        db.prepare(`
          INSERT INTO mount_credentials (id, mount_id, data, created_at, updated_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(mount_id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP
        `).run(randomUUID(), req.params.id, encrypted);
      } else {
        // Remove credentials
        db.prepare('DELETE FROM mount_credentials WHERE mount_id = ?').run(req.params.id);
      }
    }

    auditService.log({
      userId: req.user?.userId,
      action: 'mount_updated',
      resourceType: 'mount',
      resourceId: req.params.id,
      details: { name: name || existing.name },
    });

    const row = db.prepare(`
      SELECT m.*,
             CASE WHEN mc.id IS NOT NULL THEN 1 ELSE 0 END as has_credentials
      FROM mounts m
      LEFT JOIN mount_credentials mc ON mc.mount_id = m.id
      WHERE m.id = ?
    `).get(req.params.id) as (MountRow & { has_credentials: number });
    res.json(rowToMount(row, Boolean(row.has_credentials)));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/mounts/:id - Delete mount definition
router.delete('/:id', requireAuth, canManageMounts, validateParams(schemas.idParam), async (req: AuthenticatedRequest, res, next) => {
  try {
    const db = getDb();

    const existing = db.prepare('SELECT * FROM mounts WHERE id = ?').get(req.params.id) as MountRow | undefined;
    if (!existing) {
      throw createError('Mount not found', 404, 'MOUNT_NOT_FOUND');
    }

    // Check if there are active server_mounts
    const activeMounts = db.prepare(`
      SELECT COUNT(*) as count FROM server_mounts
      WHERE mount_id = ? AND status IN ('mounted', 'mounting')
    `).get(req.params.id) as { count: number };

    if (activeMounts.count > 0) {
      throw createError('Cannot delete mount with active server assignments', 400, 'MOUNT_IN_USE');
    }

    // Delete mount (cascades to mount_credentials and server_mounts)
    db.prepare('DELETE FROM mounts WHERE id = ?').run(req.params.id);

    auditService.log({
      userId: req.user?.userId,
      action: 'mount_deleted',
      resourceType: 'mount',
      resourceId: req.params.id,
      details: { name: existing.name },
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
