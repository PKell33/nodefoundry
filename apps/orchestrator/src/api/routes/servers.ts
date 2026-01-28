import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import { getDb } from '../../db/index.js';
import { createError } from '../middleware/error.js';
import type { Server, ServerMetrics } from '@nodefoundry/shared';

const router = Router();

interface ServerRow {
  id: string;
  name: string;
  host: string | null;
  is_foundry: number;
  agent_status: string;
  auth_token: string | null;
  metrics: string | null;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
}

function rowToServer(row: ServerRow): Server {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    isFoundry: Boolean(row.is_foundry),
    agentStatus: row.agent_status as Server['agentStatus'],
    authToken: row.auth_token,
    metrics: row.metrics ? JSON.parse(row.metrics) as ServerMetrics : undefined,
    lastSeen: row.last_seen ? new Date(row.last_seen) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// GET /api/servers - List all servers
router.get('/', (_req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM servers ORDER BY is_foundry DESC, name').all() as ServerRow[];
  const servers = rows.map(rowToServer);
  res.json(servers);
});

// POST /api/servers - Add a new server
router.post('/', (req, res) => {
  const { name, host } = req.body;

  if (!name || typeof name !== 'string') {
    throw createError('Server name is required', 400, 'INVALID_NAME');
  }

  if (!host || typeof host !== 'string') {
    throw createError('Server host is required', 400, 'INVALID_HOST');
  }

  const db = getDb();
  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const authToken = randomBytes(32).toString('hex');

  const existing = db.prepare('SELECT id FROM servers WHERE id = ? OR name = ?').get(id, name);
  if (existing) {
    throw createError('Server with this name already exists', 409, 'SERVER_EXISTS');
  }

  const stmt = db.prepare(`
    INSERT INTO servers (id, name, host, is_foundry, auth_token, agent_status)
    VALUES (?, ?, ?, FALSE, ?, 'offline')
  `);
  stmt.run(id, name, host, authToken);

  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as ServerRow;
  const server = rowToServer(row);

  // Return bootstrap command for the new server
  const bootstrapCommand = `curl -sSL http://${req.get('host')}/agent/install.sh | sudo bash -s -- --foundry http://${req.get('host')} --token ${authToken} --id ${id}`;

  res.status(201).json({
    server,
    bootstrapCommand,
  });
});

// GET /api/servers/:id - Get server details
router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as ServerRow | undefined;

  if (!row) {
    throw createError('Server not found', 404, 'SERVER_NOT_FOUND');
  }

  res.json(rowToServer(row));
});

// PUT /api/servers/:id - Update server
router.put('/:id', (req, res) => {
  const { name, host } = req.body;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as ServerRow | undefined;
  if (!existing) {
    throw createError('Server not found', 404, 'SERVER_NOT_FOUND');
  }

  if (existing.is_foundry) {
    throw createError('Cannot modify foundry server', 400, 'CANNOT_MODIFY_FOUNDRY');
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (name !== undefined) {
    updates.push('name = ?');
    values.push(name);
  }
  if (host !== undefined) {
    updates.push('host = ?');
    values.push(host);
  }

  if (updates.length === 0) {
    throw createError('No fields to update', 400, 'NO_UPDATES');
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(req.params.id);

  const stmt = db.prepare(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as ServerRow;
  res.json(rowToServer(row));
});

// DELETE /api/servers/:id - Remove server
router.delete('/:id', (req, res) => {
  const db = getDb();

  const existing = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as ServerRow | undefined;
  if (!existing) {
    throw createError('Server not found', 404, 'SERVER_NOT_FOUND');
  }

  if (existing.is_foundry) {
    throw createError('Cannot delete foundry server', 400, 'CANNOT_DELETE_FOUNDRY');
  }

  db.prepare('DELETE FROM servers WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

export default router;
