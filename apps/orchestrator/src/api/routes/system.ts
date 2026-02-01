import { Router } from 'express';
import { createReadStream } from 'fs';
import { getDb } from '../../db/index.js';
import { backupService } from '../../services/backupService.js';
import { configExportService, ConfigExport } from '../../services/configExportService.js';
import { requireAuth, requireSystemAdmin, AuthenticatedRequest } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validateBody, validateParams, validateQuery, schemas } from '../middleware/validate.js';
import { createError } from '../middleware/error.js';

const router = Router();

// ===============================
// Database Row Types
// ===============================

interface ServerCountRow {
  total: number;
  online: number;
}

interface DeploymentCountRow {
  total: number;
  running: number;
}

interface ProxyRouteRow {
  id: string;
  deployment_id: string;
  path: string;
  upstream: string;
  active: number;
  created_at: string;
}

// ===============================
// System Status Routes (Read-only)
// ===============================

// GET /api/system/status - Overall system status
router.get('/status', (_req, res) => {
  const db = getDb();

  const serverStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN agent_status = 'online' THEN 1 ELSE 0 END) as online
    FROM servers
  `).get() as ServerCountRow;

  const deploymentStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
    FROM deployments
  `).get() as DeploymentCountRow;

  res.json({
    status: 'ok',
    servers: {
      total: serverStats.total,
      online: serverStats.online,
    },
    deployments: {
      total: deploymentStats.total,
      running: deploymentStats.running,
    },
    timestamp: new Date().toISOString(),
  });
});

// GET /api/system/proxy-routes - Current proxy configuration
router.get('/proxy-routes', (_req, res) => {
  const db = getDb();

  const rows = db.prepare(`
    SELECT pr.*, d.app_name, s.name as server_name
    FROM proxy_routes pr
    JOIN deployments d ON pr.deployment_id = d.id
    JOIN servers s ON d.server_id = s.id
    WHERE pr.active = TRUE
    ORDER BY pr.path
  `).all() as (ProxyRouteRow & { app_name: string; server_name: string })[];

  const routes = rows.map(row => ({
    id: row.id,
    path: row.path,
    upstream: row.upstream,
    appName: row.app_name,
    serverName: row.server_name,
    createdAt: new Date(row.created_at),
  }));

  res.json(routes);
});

// ===============================
// Backup Routes (System Admin Only)
// ===============================

// POST /api/system/backup - Create a new backup
router.post('/backup', requireAuth, requireSystemAdmin, csrfProtection, async (_req, res, next) => {
  try {
    const result = await backupService.createBackup();
    res.status(201).json({
      success: true,
      backup: {
        filename: result.filename,
        path: result.path,
        size: result.size,
        checksum: result.checksum,
        createdAt: result.timestamp,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/system/backups - List all backups
router.get('/backups', requireAuth, requireSystemAdmin, (_req, res, next) => {
  try {
    const backups = backupService.listBackups();
    res.json({
      backups: backups.map(b => ({
        filename: b.filename,
        size: b.size,
        createdAt: b.createdAt,
      })),
      backupPath: backupService.getBackupPath(),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/system/backups/:filename - Download a backup file
router.get('/backups/:filename', requireAuth, requireSystemAdmin, validateParams(schemas.system.backupFilename), (req, res, next) => {
  try {
    const { filename } = req.params;
    const backup = backupService.getBackup(filename);

    if (!backup) {
      throw createError('Backup not found', 404, 'BACKUP_NOT_FOUND');
    }

    res.setHeader('Content-Type', 'application/x-sqlite3');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', backup.size);

    const stream = createReadStream(backup.path);
    stream.pipe(res);
    stream.on('error', (err) => {
      next(err);
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/system/backups/:filename - Delete a backup
router.delete('/backups/:filename', requireAuth, requireSystemAdmin, csrfProtection, validateParams(schemas.system.backupFilename), (req, res, next) => {
  try {
    const { filename } = req.params;
    const deleted = backupService.deleteBackup(filename);

    if (!deleted) {
      throw createError('Backup not found', 404, 'BACKUP_NOT_FOUND');
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/system/backups/prune - Delete old backups
router.post('/backups/prune', requireAuth, requireSystemAdmin, csrfProtection, validateBody(schemas.system.pruneBackups), (req, res, next) => {
  try {
    const { keepDays } = req.body;
    const deletedCount = backupService.pruneBackups(keepDays);

    res.json({
      success: true,
      deletedCount,
      message: `Deleted ${deletedCount} backup(s) older than ${keepDays} days`,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/system/restore - Restore from backup (DANGEROUS)
router.post('/restore', requireAuth, requireSystemAdmin, csrfProtection, validateBody(schemas.system.restore), async (req, res, next) => {
  try {
    const { filename } = req.body;
    const backup = backupService.getBackup(filename);

    if (!backup) {
      throw createError('Backup not found', 404, 'BACKUP_NOT_FOUND');
    }

    const result = await backupService.restoreFromBackup(backup.path);

    res.json({
      success: result.success,
      tablesRestored: result.tablesRestored,
      warnings: result.warnings,
      message: 'Database restored. Restart the orchestrator for changes to take full effect.',
    });
  } catch (err) {
    next(err);
  }
});

// ===============================
// Config Export/Import Routes (System Admin Only)
// ===============================

// GET /api/system/export - Export configuration
router.get('/export', requireAuth, requireSystemAdmin, validateQuery(schemas.system.exportConfig), async (req: AuthenticatedRequest, res, next) => {
  try {
    // Query params are validated and coerced by Zod
    const query = req.query as unknown as {
      includeUsers: boolean;
      includeDeployments: boolean;
      includeAuditLog: boolean;
    };

    const configData = await configExportService.exportConfig({
      includeUsers: query.includeUsers,
      includeDeployments: query.includeDeployments,
      includeAuditLog: query.includeAuditLog,
    });

    // Set filename for download
    const timestamp = new Date().toISOString().replace(/[:-]/g, '').replace('T', '-').slice(0, 15);
    res.setHeader('Content-Disposition', `attachment; filename="ownprem-config-${timestamp}.json"`);
    res.json(configData);
  } catch (err) {
    next(err);
  }
});

// POST /api/system/import/validate - Validate config before import
router.post('/import/validate', requireAuth, requireSystemAdmin, validateBody(schemas.system.validateImport), (req, res, next) => {
  try {
    const { config } = req.body;
    const result = configExportService.validateConfig(config);

    res.json({
      valid: result.valid,
      errors: result.errors,
      warnings: result.warnings,
      summary: result.summary,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/system/import - Import configuration
router.post('/import', requireAuth, requireSystemAdmin, csrfProtection, validateBody(schemas.system.importConfig), async (req, res, next) => {
  try {
    const { config, options } = req.body;

    const result = await configExportService.importConfig(config as ConfigExport, options);

    res.json({
      success: result.success,
      imported: result.imported,
      skipped: result.skipped,
      warnings: result.warnings,
      errors: result.errors,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
