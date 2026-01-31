/**
 * Web UI route management for proxy.
 * Handles registration and state of app web UI routes.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import type { AppManifest } from '@ownprem/shared';
import type { ProxyRoute, ProxyRouteRow } from './proxyTypes.js';

/**
 * Register a web UI route for a deployment.
 * Creates the route as inactive - will be activated when app is started.
 */
export async function registerWebUiRoute(
  deploymentId: string,
  manifest: AppManifest,
  serverHost: string
): Promise<void> {
  if (!manifest.webui?.enabled) {
    return;
  }

  const db = getDb();
  const path = manifest.webui.basePath;
  const host = serverHost || '127.0.0.1';
  const upstream = `http://${host}:${manifest.webui.port}`;

  const existing = db.prepare('SELECT id FROM proxy_routes WHERE path = ?').get(path) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE proxy_routes SET upstream = ?, active = FALSE, deployment_id = ?
      WHERE id = ?
    `).run(upstream, deploymentId, existing.id);
  } else {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO proxy_routes (id, deployment_id, path, upstream, active)
      VALUES (?, ?, ?, ?, FALSE)
    `).run(id, deploymentId, path, upstream);
  }
}

/**
 * Unregister all web UI routes for a deployment.
 */
export async function unregisterWebUiRoute(deploymentId: string): Promise<void> {
  const db = getDb();
  db.prepare('DELETE FROM proxy_routes WHERE deployment_id = ?').run(deploymentId);
}

/**
 * Set the active state of a web UI route.
 */
export async function setWebUiRouteActive(deploymentId: string, active: boolean): Promise<void> {
  const db = getDb();
  db.prepare('UPDATE proxy_routes SET active = ? WHERE deployment_id = ?').run(active ? 1 : 0, deploymentId);
}

/**
 * Get all active web UI routes.
 */
export async function getActiveWebUiRoutes(): Promise<ProxyRoute[]> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT pr.*, d.app_name, s.name as server_name
    FROM proxy_routes pr
    JOIN deployments d ON pr.deployment_id = d.id
    JOIN servers s ON d.server_id = s.id
    WHERE pr.active = TRUE
    ORDER BY pr.path
  `).all() as (ProxyRouteRow & { app_name: string; server_name: string })[];

  return rows.map(row => ({
    id: row.id,
    path: row.path,
    upstream: row.upstream,
    appName: row.app_name,
    serverName: row.server_name,
  }));
}
