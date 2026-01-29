import { Router } from 'express';
import { proxyManager } from '../../services/proxyManager.js';
import { getDb } from '../../db/index.js';

const router = Router();

// GET /api/proxy-routes - List all proxy routes (for Caddy integration)
// This endpoint is unauthenticated to allow local Caddy scripts to query it
router.get('/', async (_req, res, next) => {
  try {
    const routes = await proxyManager.getActiveRoutes();
    res.json(routes.map(route => ({
      path: route.path,
      upstream: route.upstream,
      appName: route.appName,
      serverName: route.serverName,
      active: true,
    })));
  } catch (err) {
    next(err);
  }
});

// GET /api/proxy-routes/caddy - Generate Caddy snippet for app routes
router.get('/caddy', async (_req, res, next) => {
  try {
    const routes = await proxyManager.getActiveRoutes();

    let config = '# Auto-generated app routes\n';
    config += '# Generated: ' + new Date().toISOString() + '\n\n';

    for (const route of routes) {
      config += `# ${route.appName} on ${route.serverName}\n`;
      config += `handle ${route.path}/* {\n`;
      config += `    reverse_proxy ${route.upstream} {\n`;
      config += `        header_up X-Forwarded-Prefix ${route.path}\n`;
      config += `    }\n`;
      config += `}\n\n`;
    }

    res.type('text/plain').send(config);
  } catch (err) {
    next(err);
  }
});

// POST /api/proxy-routes/reload - Trigger Caddy config update via Admin API
router.post('/reload', async (_req, res, next) => {
  try {
    const success = await proxyManager.updateAndReload();
    if (success) {
      res.json({ status: 'ok', message: 'Caddy config updated successfully' });
    } else {
      res.status(500).json({ error: { code: 'CADDY_UPDATE_FAILED', message: 'Failed to update Caddy config' } });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/proxy-routes/status - Check Caddy status
router.get('/status', async (_req, res, next) => {
  try {
    const db = getDb();
    const routeCount = db.prepare('SELECT COUNT(*) as count FROM proxy_routes WHERE active = TRUE').get() as { count: number };

    res.json({
      activeRoutes: routeCount.count,
      routes: await proxyManager.getActiveRoutes(),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
