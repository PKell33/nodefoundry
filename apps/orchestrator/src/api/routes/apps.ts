/**
 * Apps API - Browse and manage apps from Umbrel App Stores
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { requireAuth } from '../middleware/auth.js';
import { validateParams, validateQuery, validateBody } from '../middleware/validate.js';
import { Errors } from '../middleware/error.js';
import { appStoreService } from '../../services/appStoreService.js';
import { config } from '../../config.js';
import { z } from 'zod';

const router = Router();

// ==================== Public Icon Routes (no auth) ====================
const iconRouter = Router();

// GET /api/apps/:registry/:id/icon - Get app icon (registry-specific)
iconRouter.get('/:registry/:id/icon', validateParams(z.object({
  registry: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  id: z.string().min(1).max(100)
})), (req, res, next) => {
  try {
    const { registry, id } = req.params;
    const svgPath = join(config.paths.icons, 'umbrel', registry, `${id}.svg`);
    const pngPath = join(config.paths.icons, 'umbrel', registry, `${id}.png`);

    if (existsSync(svgPath)) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(svgPath);
      return;
    }

    if (existsSync(pngPath)) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(pngPath);
      return;
    }

    // Fall back to old icon location for backward compatibility
    const oldIconPath = join(config.paths.icons, `${id}.svg`);
    if (existsSync(oldIconPath)) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(oldIconPath);
      return;
    }

    res.status(404).end();
  } catch (err) {
    next(err);
  }
});

// GET /api/apps/:id/icon - Legacy icon route
iconRouter.get('/:id/icon', validateParams(z.object({ id: z.string().min(1).max(100) })), async (req, res, next) => {
  try {
    const id = req.params.id;

    // Try old location first for backward compatibility
    const oldIconPath = join(config.paths.icons, `${id}.svg`);
    if (existsSync(oldIconPath)) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(oldIconPath);
      return;
    }

    // Try registry-specific locations
    const registries = await appStoreService.getRegistries();
    for (const registry of registries) {
      const svgPath = join(config.paths.icons, 'umbrel', registry.id, `${id}.svg`);
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

// Query schema for apps list
const appsQuerySchema = z.object({
  category: z.string().min(1).max(50).optional(),
});

// ==================== Registry Management ====================

// GET /api/apps/registries - List all registries
router.get('/registries', requireAuth, async (req, res, next) => {
  try {
    const registries = await appStoreService.getRegistries();
    res.json({ registries });
  } catch (err) {
    next(err);
  }
});

// POST /api/apps/registries - Add a new registry
router.post('/registries', requireAuth, validateBody(z.object({
  id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'ID must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1).max(100),
  url: z.string().url(),
})), async (req, res, next) => {
  try {
    const { id, name, url } = req.body;
    const registry = await appStoreService.addRegistry(id, name, url);
    res.status(201).json(registry);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      res.status(409).json({ error: { code: 'DUPLICATE_REGISTRY', message: err.message } });
      return;
    }
    next(err);
  }
});

// PUT /api/apps/registries/:id - Update a registry
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
    const registry = await appStoreService.updateRegistry(req.params.id, req.body);
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

// DELETE /api/apps/registries/:id - Remove a registry
router.delete('/registries/:id', requireAuth, validateParams(z.object({
  id: z.string().min(1).max(50),
})), async (req, res, next) => {
  try {
    const deleted = await appStoreService.removeRegistry(req.params.id);
    if (!deleted) {
      throw Errors.notFound('Registry', req.params.id);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ==================== App Management ====================

// GET /api/apps - List available apps
router.get('/', requireAuth, validateQuery(appsQuerySchema), async (req, res, next) => {
  try {
    const category = req.query.category as string | undefined;
    const apps = category
      ? await appStoreService.getAppsByCategory(category)
      : await appStoreService.getApps();

    res.json({
      apps,
      count: apps.length,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/apps/categories - Get all categories with counts
router.get('/categories', requireAuth, async (req, res, next) => {
  try {
    const categories = await appStoreService.getCategories();
    res.json({ categories });
  } catch (err) {
    next(err);
  }
});

// POST /api/apps/sync - Sync apps from Umbrel registries
router.post('/sync', requireAuth, async (req, res, next) => {
  try {
    const registryId = req.query.registry as string | undefined;

    if (registryId) {
      const registry = await appStoreService.getRegistry(registryId);
      if (!registry) {
        res.status(400).json({ error: { code: 'INVALID_REGISTRY', message: `Registry not found: ${registryId}` } });
        return;
      }
    }

    const result = await appStoreService.syncApps(registryId);

    const parts = [];
    if (result.synced > 0) parts.push(`${result.synced} new`);
    if (result.updated > 0) parts.push(`${result.updated} updated`);
    if (result.removed > 0) parts.push(`${result.removed} removed`);
    const summary = parts.length > 0 ? parts.join(', ') : 'No changes';

    let registryName = 'Umbrel';
    if (registryId) {
      const registry = await appStoreService.getRegistry(registryId);
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

// GET /api/apps/sync - Also support GET for sync (backward compatibility)
router.get('/sync', requireAuth, async (req, res, next) => {
  try {
    const result = await appStoreService.syncApps();

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

// GET /api/apps/status - Get sync status
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const needsSync = await appStoreService.needsSync();
    const appCount = await appStoreService.getAppCount();

    res.json({
      needsSync,
      appCount,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/apps/:id - Get specific app details
router.get('/:id', requireAuth, validateParams(z.object({ id: z.string().min(1).max(100) })), async (req, res, next) => {
  try {
    const app = await appStoreService.getApp(req.params.id);

    if (!app) {
      throw Errors.notFound('App', req.params.id);
    }

    res.json(app);
  } catch (err) {
    next(err);
  }
});

// Export both routers
export default Object.assign(router, { iconRouter });
