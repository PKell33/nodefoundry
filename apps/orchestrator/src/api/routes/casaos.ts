/**
 * CasaOS Apps API - Browse and manage apps from CasaOS-compatible stores
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { requireAuth } from '../middleware/auth.js';
import { validateParams, validateBody } from '../middleware/validate.js';
import { Errors } from '../middleware/error.js';
import { casaosStoreService } from '../../services/casaosStoreService.js';
import { config } from '../../config.js';
import { z } from 'zod';

const router = Router();

// ==================== Public Icon Routes (no auth) ====================
const iconRouter = Router();

// GET /api/casaos/apps/:registry/:id/icon - Get app icon
iconRouter.get('/:registry/:id/icon', validateParams(z.object({
  registry: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  id: z.string().min(1).max(100)
})), (req, res, next) => {
  try {
    const { registry, id } = req.params;
    const pngPath = join(config.paths.icons, 'casaos', registry, `${id}.png`);
    const svgPath = join(config.paths.icons, 'casaos', registry, `${id}.svg`);

    if (existsSync(pngPath)) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(pngPath);
      return;
    }

    if (existsSync(svgPath)) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(svgPath);
      return;
    }

    res.status(404).end();
  } catch (err) {
    next(err);
  }
});

// GET /api/casaos/apps/:id/icon - Legacy icon route
iconRouter.get('/:id/icon', validateParams(z.object({ id: z.string().min(1).max(100) })), async (req, res, next) => {
  try {
    const id = req.params.id;

    const registries = await casaosStoreService.getRegistries();
    const registryIds = registries.map(r => r.id);

    for (const registry of registryIds) {
      const pngPath = join(config.paths.icons, 'casaos', registry, `${id}.png`);
      if (existsSync(pngPath)) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(pngPath);
        return;
      }

      const svgPath = join(config.paths.icons, 'casaos', registry, `${id}.svg`);
      if (existsSync(svgPath)) {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(svgPath);
        return;
      }
    }

    res.status(404).end();
  } catch (err) {
    next(err);
  }
});

// ==================== Registry Management ====================

// GET /api/casaos/registries - List all registries
router.get('/registries', requireAuth, async (req, res, next) => {
  try {
    const registries = await casaosStoreService.getRegistries();
    res.json({ registries });
  } catch (err) {
    next(err);
  }
});

// POST /api/casaos/registries - Add a new registry
router.post('/registries', requireAuth, validateBody(z.object({
  id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'ID must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1).max(100),
  url: z.string().url(),
})), async (req, res, next) => {
  try {
    const { id, name, url } = req.body;
    const registry = await casaosStoreService.addRegistry(id, name, url);
    res.status(201).json(registry);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      res.status(409).json({ error: { code: 'DUPLICATE_REGISTRY', message: err.message } });
      return;
    }
    next(err);
  }
});

// PUT /api/casaos/registries/:id - Update a registry
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
    const registry = await casaosStoreService.updateRegistry(req.params.id, req.body);
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

// DELETE /api/casaos/registries/:id - Remove a registry
router.delete('/registries/:id', requireAuth, validateParams(z.object({
  id: z.string().min(1).max(50),
})), async (req, res, next) => {
  try {
    const deleted = await casaosStoreService.removeRegistry(req.params.id);
    if (!deleted) {
      throw Errors.notFound('Registry', req.params.id);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ==================== App Management ====================

// GET /api/casaos/apps - List all CasaOS apps
router.get('/apps', requireAuth, async (req, res, next) => {
  try {
    const apps = await casaosStoreService.getApps();

    res.json({
      apps,
      count: apps.length,
      source: 'casaos',
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/casaos/apps/sync - Sync apps from CasaOS registries
router.post('/apps/sync', requireAuth, async (req, res, next) => {
  try {
    const registryId = req.query.registry as string | undefined;

    if (registryId) {
      const registry = await casaosStoreService.getRegistry(registryId);
      if (!registry) {
        res.status(400).json({ error: { code: 'INVALID_REGISTRY', message: `Registry not found: ${registryId}` } });
        return;
      }
    }

    const result = await casaosStoreService.syncApps(registryId);

    const parts = [];
    if (result.synced > 0) parts.push(`${result.synced} new`);
    if (result.updated > 0) parts.push(`${result.updated} updated`);
    if (result.removed > 0) parts.push(`${result.removed} removed`);
    const summary = parts.length > 0 ? parts.join(', ') : 'No changes';

    let registryName = 'CasaOS';
    if (registryId) {
      const registry = await casaosStoreService.getRegistry(registryId);
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

// GET /api/casaos/apps/status - Get sync status
router.get('/apps/status', requireAuth, async (req, res, next) => {
  try {
    const appCount = await casaosStoreService.getAppCount();

    res.json({
      appCount,
      source: 'casaos',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/casaos/apps/:id - Get specific app details
router.get('/apps/:id', requireAuth, validateParams(z.object({ id: z.string().min(1).max(100) })), async (req, res, next) => {
  try {
    const app = await casaosStoreService.getApp(req.params.id);

    if (!app) {
      throw Errors.notFound('CasaOS App', req.params.id);
    }

    res.json(app);
  } catch (err) {
    next(err);
  }
});

// Export both routers
export default Object.assign(router, { iconRouter });
