import { Router } from 'express';
import { getDb } from '../../db/index.js';

const router = Router();

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

export default router;
