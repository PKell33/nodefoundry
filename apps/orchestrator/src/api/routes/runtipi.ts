/**
 * Runtipi Apps API - Browse and manage apps from Runtipi-compatible stores
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { requireAuth } from '../middleware/auth.js';
import { validateParams, validateBody } from '../middleware/validate.js';
import { Errors } from '../middleware/error.js';
import { runtipiStoreService } from '../../services/runtipiStoreService.js';
import { config } from '../../config.js';
import { z } from 'zod';

const router = Router();

// ==================== Public Icon Routes (no auth) ====================
const iconRouter = Router();

// GET /api/runtipi/apps/:registry/:id/icon - Get app icon
iconRouter.get('/:registry/:id/icon', validateParams(z.object({
  registry: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  id: z.string().min(1).max(100)
})), (req, res, next) => {
  try {
    const { registry, id } = req.params;
    const jpgPath = join(config.paths.icons, 'runtipi', registry, `${id}.jpg`);
    const pngPath = join(config.paths.icons, 'runtipi', registry, `${id}.png`);

    if (existsSync(jpgPath)) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(jpgPath);
      return;
    }

    if (existsSync(pngPath)) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(pngPath);
      return;
    }

    res.status(404).end();
  } catch (err) {
    next(err);
  }
});

// GET /api/runtipi/apps/:id/icon - Legacy icon route
iconRouter.get('/:id/icon', validateParams(z.object({ id: z.string().min(1).max(100) })), async (req, res, next) => {
  try {
    const id = req.params.id;

    const registries = await runtipiStoreService.getRegistries();
    const registryIds = registries.map(r => r.id);

    for (const registry of registryIds) {
      const jpgPath = join(config.paths.icons, 'runtipi', registry, `${id}.jpg`);
      if (existsSync(jpgPath)) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(jpgPath);
        return;
      }

      const pngPath = join(config.paths.icons, 'runtipi', registry, `${id}.png`);
      if (existsSync(pngPath)) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(pngPath);
        return;
      }
    }

    res.status(404).end();
  } catch (err) {
    next(err);
  }
});

// ==================== Registry Management ====================

// GET /api/runtipi/registries - List all registries
router.get('/registries', requireAuth, async (req, res, next) => {
  try {
    const registries = await runtipiStoreService.getRegistries();
    res.json({ registries });
  } catch (err) {
    next(err);
  }
});

// POST /api/runtipi/registries - Add a new registry
router.post('/registries', requireAuth, validateBody(z.object({
  id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'ID must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1).max(100),
  url: z.string().url(),
})), async (req, res, next) => {
  try {
    const { id, name, url } = req.body;
    const registry = await runtipiStoreService.addRegistry(id, name, url);
    res.status(201).json(registry);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      res.status(409).json({ error: { code: 'DUPLICATE_REGISTRY', message: err.message } });
      return;
    }
    next(err);
  }
});

// PUT /api/runtipi/registries/:id - Update a registry
router.put('/registries/:id', requireAuth, validateParams(z.object({
  id: z.string().min(1).max(50),
})), validateBody(z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().optional(),
  enabled: z.boolean().optional(),
}).refine(data => data.name || data.url || data.enabled !== undefined, {
  message: 'At least one field must be provided',
})), async (req, res, next) => {
  try {
    const registry = await runtipiStoreService.updateRegistry(req.params.id, req.body);
    if (!registry) {
      throw Errors.notFound('Registry', req.params.id);
    }
    res.json(registry);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      res.status(409).json({ error: { code: 'DUPLICATE_REGISTRY', message: err.message } });
      return;
    }
    next(err);
  }
});

// DELETE /api/runtipi/registries/:id - Remove a registry
router.delete('/registries/:id', requireAuth, validateParams(z.object({
  id: z.string().min(1).max(50),
})), async (req, res, next) => {
  try {
    const deleted = await runtipiStoreService.removeRegistry(req.params.id);
    if (!deleted) {
      throw Errors.notFound('Registry', req.params.id);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ==================== App Management ====================

// GET /api/runtipi/apps - List all Runtipi apps
router.get('/apps', requireAuth, async (req, res, next) => {
  try {
    const apps = await runtipiStoreService.getApps();

    res.json({
      apps,
      count: apps.length,
      source: 'runtipi',
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/runtipi/apps/sync - Sync apps from Runtipi registries
router.post('/apps/sync', requireAuth, async (req, res, next) => {
  try {
    const registryId = req.query.registry as string | undefined;

    if (registryId) {
      const registry = await runtipiStoreService.getRegistry(registryId);
      if (!registry) {
        res.status(400).json({ error: { code: 'INVALID_REGISTRY', message: `Registry not found: ${registryId}` } });
        return;
      }
    }

    const result = await runtipiStoreService.syncApps(registryId);

    const parts = [];
    if (result.synced > 0) parts.push(`${result.synced} new`);
    if (result.updated > 0) parts.push(`${result.updated} updated`);
    if (result.removed > 0) parts.push(`${result.removed} removed`);
    const summary = parts.length > 0 ? parts.join(', ') : 'No changes';

    let registryName = 'Runtipi';
    if (registryId) {
      const registry = await runtipiStoreService.getRegistry(registryId);
      registryName = registry?.name || registryId;
    }

    res.json({
      synced: result.synced,
      updated: result.updated,
      removed: result.removed,
      errors: result.errors,
      registry: registryId || 'all',
      message: `${registryName}: ${summary}${result.errors.length > 0 ? ` (${result.errors.length} errors)` : ''}`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/runtipi/apps/status - Get sync status
router.get('/apps/status', requireAuth, async (req, res, next) => {
  try {
    const appCount = await runtipiStoreService.getAppCount();

    res.json({
      appCount,
      source: 'runtipi',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/runtipi/apps/:id - Get specific app details
router.get('/apps/:id', requireAuth, validateParams(z.object({ id: z.string().min(1).max(100) })), async (req, res, next) => {
  try {
    const app = await runtipiStoreService.getApp(req.params.id);

    if (!app) {
      throw Errors.notFound('Runtipi App', req.params.id);
    }

    res.json(app);
  } catch (err) {
    next(err);
  }
});

// Export both routers
export default Object.assign(router, { iconRouter });
