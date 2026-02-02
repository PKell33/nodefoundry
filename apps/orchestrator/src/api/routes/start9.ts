/**
 * Start9 Apps API - Browse and manage apps from Start9 Marketplace
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { requireAuth } from '../middleware/auth.js';
import { validateParams, validateBody } from '../middleware/validate.js';
import { Errors } from '../middleware/error.js';
import { start9StoreService } from '../../services/start9StoreService.js';
import { config } from '../../config.js';
import { z } from 'zod';

const router = Router();

// ==================== Public Icon Routes (no auth) ====================
// These are mounted separately without auth middleware for <img> tags
const iconRouter = Router();

// GET /api/start9/apps/:registry/:id/icon - Get app icon (with registry)
iconRouter.get('/:registry/:id/icon', validateParams(z.object({
  registry: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  id: z.string().min(1).max(100)
})), (req, res, next) => {
  try {
    const { registry, id } = req.params;
    const pngPath = join(config.paths.icons, 'start9', registry, `${id}.png`);
    const svgPath = join(config.paths.icons, 'start9', registry, `${id}.svg`);

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

// GET /api/start9/apps/:id/icon - Legacy icon route (fallback, checks all registries)
iconRouter.get('/:id/icon', validateParams(z.object({ id: z.string().min(1).max(100) })), async (req, res, next) => {
  try {
    const id = req.params.id;

    // Get all registry IDs from database
    const registries = await start9StoreService.getRegistries();
    const registryIds = registries.map(r => r.id);
    registryIds.push(''); // Also check root start9 directory

    for (const registry of registryIds) {
      const baseDir = registry ? join(config.paths.icons, 'start9', registry) : join(config.paths.icons, 'start9');

      const pngPath = join(baseDir, `${id}.png`);
      if (existsSync(pngPath)) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(pngPath);
        return;
      }

      const svgPath = join(baseDir, `${id}.svg`);
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

// GET /api/start9/registries - List all registries
router.get('/registries', requireAuth, async (req, res, next) => {
  try {
    const registries = await start9StoreService.getRegistries();
    res.json({ registries });
  } catch (err) {
    next(err);
  }
});

// POST /api/start9/registries - Add a new registry
router.post('/registries', requireAuth, validateBody(z.object({
  id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'ID must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1).max(100),
  url: z.string().url(),
})), async (req, res, next) => {
  try {
    const { id, name, url } = req.body;
    const registry = await start9StoreService.addRegistry(id, name, url);
    res.status(201).json(registry);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      res.status(409).json({ error: { code: 'DUPLICATE_REGISTRY', message: err.message } });
      return;
    }
    next(err);
  }
});

// PUT /api/start9/registries/:id - Update a registry
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
    const registry = await start9StoreService.updateRegistry(req.params.id, req.body);
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

// DELETE /api/start9/registries/:id - Remove a registry
router.delete('/registries/:id', requireAuth, validateParams(z.object({
  id: z.string().min(1).max(50),
})), async (req, res, next) => {
  try {
    const deleted = await start9StoreService.removeRegistry(req.params.id);
    if (!deleted) {
      throw Errors.notFound('Registry', req.params.id);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ==================== App Management ====================

// GET /api/start9/apps - List all Start9 apps
router.get('/apps', requireAuth, async (req, res, next) => {
  try {
    const apps = await start9StoreService.getApps();

    res.json({
      apps,
      count: apps.length,
      source: 'start9',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/start9/apps/sync - Sync apps from Start9 GitHub
router.get('/apps/sync', requireAuth, async (req, res, next) => {
  try {
    const result = await start9StoreService.syncApps();

    const parts = [];
    if (result.synced > 0) parts.push(`${result.synced} new`);
    if (result.updated > 0) parts.push(`${result.updated} updated`);
    if (result.removed > 0) parts.push(`${result.removed} removed`);
    const summary = parts.length > 0 ? parts.join(', ') : 'No changes';

    res.json({
      synced: result.synced,
      updated: result.updated,
      removed: result.removed,
      errors: result.errors,
      message: `${summary}${result.errors.length > 0 ? ` (${result.errors.length} errors)` : ''}`,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/start9/apps/sync - Force sync apps from Start9 registries
// Optional query param: ?registry=<registry-id>
router.post('/apps/sync', requireAuth, async (req, res, next) => {
  try {
    const registryId = req.query.registry as string | undefined;

    // Validate registry exists if provided
    if (registryId) {
      const registry = await start9StoreService.getRegistry(registryId);
      if (!registry) {
        res.status(400).json({ error: { code: 'INVALID_REGISTRY', message: `Registry not found: ${registryId}` } });
        return;
      }
    }

    const result = await start9StoreService.syncApps(registryId);

    const parts = [];
    if (result.synced > 0) parts.push(`${result.synced} new`);
    if (result.updated > 0) parts.push(`${result.updated} updated`);
    if (result.removed > 0) parts.push(`${result.removed} removed`);
    const summary = parts.length > 0 ? parts.join(', ') : 'No changes';

    // Get registry name for message
    let registryName = 'Start9';
    if (registryId) {
      const registry = await start9StoreService.getRegistry(registryId);
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

// GET /api/start9/apps/status - Get sync status
router.get('/apps/status', requireAuth, async (req, res, next) => {
  try {
    const needsSync = await start9StoreService.needsSync();
    const appCount = await start9StoreService.getAppCount();

    res.json({
      needsSync,
      appCount,
      source: 'start9',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/start9/apps/:id - Get specific app details
router.get('/apps/:id', requireAuth, validateParams(z.object({ id: z.string().min(1).max(100) })), async (req, res, next) => {
  try {
    const app = await start9StoreService.getApp(req.params.id);

    if (!app) {
      throw Errors.notFound('Start9 App', req.params.id);
    }

    res.json(app);
  } catch (err) {
    next(err);
  }
});

// POST /api/start9/apps/:id/load-image - Download s9pk and load Docker image
router.post('/apps/:id/load-image', requireAuth, validateParams(z.object({ id: z.string().min(1).max(100) })), async (req, res, next) => {
  try {
    const app = await start9StoreService.getApp(req.params.id);

    if (!app) {
      throw Errors.notFound('Start9 App', req.params.id);
    }

    const s9pkUrl = await start9StoreService.getS9pkUrl(req.params.id);
    if (!s9pkUrl) {
      throw Errors.validation('No s9pk package available for this app');
    }

    const imageId = await start9StoreService.loadDockerImage(req.params.id);

    res.json({
      success: true,
      appId: req.params.id,
      imageId,
      message: `Loaded Docker image: ${imageId}`,
    });
  } catch (err) {
    next(err);
  }
});

// Export both routers
export default Object.assign(router, { iconRouter });
