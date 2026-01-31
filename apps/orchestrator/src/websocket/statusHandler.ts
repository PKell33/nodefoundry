/**
 * Agent status report handling.
 * Processes status updates from agents and syncs deployment states.
 */

import type { Server as SocketServer } from 'socket.io';
import { getDb } from '../db/index.js';
import { wsLogger } from '../lib/logger.js';
import { mutexManager } from '../lib/mutexManager.js';
import { proxyManager } from '../services/proxyManager.js';
import { broadcastDeploymentStatus } from './broadcast.js';
import type { AgentStatusReport } from '@ownprem/shared';
import { AppStatusValues, DeploymentStatusValues, TRANSIENT_DEPLOYMENT_STATES } from '@ownprem/shared';
import type { DeploymentRow } from './agentTypes.js';

/**
 * Map agent app status to deployment status.
 */
function mapAppStatusToDeploymentStatus(appStatus: string): string {
  switch (appStatus) {
    case AppStatusValues.RUNNING: return DeploymentStatusValues.RUNNING;
    case AppStatusValues.STOPPED: return DeploymentStatusValues.STOPPED;
    case AppStatusValues.ERROR: return DeploymentStatusValues.ERROR;
    default: return DeploymentStatusValues.STOPPED;
  }
}

/**
 * Handle status report from agent.
 * Optimized for performance with batch queries and debounced Caddy reloads.
 */
export async function handleStatusReport(
  io: SocketServer,
  serverId: string,
  report: AgentStatusReport
): Promise<void> {
  const db = getDb();

  // Update server metrics
  db.prepare(`
    UPDATE servers SET metrics = ?, network_info = ?, last_seen = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    JSON.stringify(report.metrics),
    report.networkInfo ? JSON.stringify(report.networkInfo) : null,
    serverId
  );

  // Skip deployment processing if no apps reported
  if (!report.apps || report.apps.length === 0) {
    io.to('authenticated').emit('server:status', {
      serverId,
      timestamp: report.timestamp,
      metrics: report.metrics,
      networkInfo: report.networkInfo,
      apps: report.apps,
    });
    return;
  }

  // Batch fetch all deployments for this server's reported apps
  const appNames = report.apps.map(a => a.name);
  const placeholders = appNames.map(() => '?').join(',');
  const deployments = db.prepare(`
    SELECT d.id, d.app_name, d.status, pr.active as route_active
    FROM deployments d
    LEFT JOIN proxy_routes pr ON pr.deployment_id = d.id
    WHERE d.server_id = ? AND d.app_name IN (${placeholders})
  `).all(serverId, ...appNames) as DeploymentRow[];

  // Create lookup map for O(1) access
  const deploymentMap = new Map(deployments.map(d => [d.app_name, d]));

  let routesChanged = false;

  // Collect status changes for batch processing
  const statusChanges: Array<{
    deploymentId: string;
    appName: string;
    newStatus: string;
    previousStatus: string;
    hasRoute: boolean;
    shouldRouteBeActive: boolean;
  }> = [];

  // Process each app's status
  for (const app of report.apps) {
    const deployment = deploymentMap.get(app.name);
    if (!deployment) {
      continue;
    }

    const newStatus = mapAppStatusToDeploymentStatus(app.status);
    const previousStatus = deployment.status;
    const hasRoute = deployment.route_active !== null;
    const shouldRouteBeActive = newStatus === DeploymentStatusValues.RUNNING;

    // Skip if already in a transitional state
    if (TRANSIENT_DEPLOYMENT_STATES.includes(previousStatus as typeof TRANSIENT_DEPLOYMENT_STATES[number])) {
      continue;
    }

    // Only process if status changed
    if (previousStatus !== newStatus) {
      statusChanges.push({
        deploymentId: deployment.id,
        appName: app.name,
        newStatus,
        previousStatus,
        hasRoute,
        shouldRouteBeActive,
      });
    }
  }

  // Apply all status updates
  for (const change of statusChanges) {
    await mutexManager.withDeploymentLock(change.deploymentId, async () => {
      // Re-check status in case it changed while waiting for lock
      const current = db.prepare('SELECT status FROM deployments WHERE id = ?').get(change.deploymentId) as { status: string } | undefined;
      if (!current || TRANSIENT_DEPLOYMENT_STATES.includes(current.status as typeof TRANSIENT_DEPLOYMENT_STATES[number])) {
        return;
      }

      db.prepare(`
        UPDATE deployments SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(change.newStatus, change.deploymentId);

      if (change.hasRoute) {
        await proxyManager.setRouteActive(change.deploymentId, change.shouldRouteBeActive);
        wsLogger.debug({
          deploymentId: change.deploymentId,
          appName: change.appName,
          routeActive: change.shouldRouteBeActive,
        }, 'Web UI route state updated based on agent status');
      }

      await proxyManager.setServiceRoutesActiveByDeployment(change.deploymentId, change.shouldRouteBeActive);
      routesChanged = true;

      broadcastDeploymentStatus({
        deploymentId: change.deploymentId,
        appName: change.appName,
        serverId,
        status: change.newStatus,
        previousStatus: change.previousStatus,
        routeActive: change.hasRoute ? change.shouldRouteBeActive : undefined,
      });
    });
  }

  // Schedule debounced Caddy reload if routes changed
  // This coalesces multiple status reports into a single reload
  if (routesChanged) {
    proxyManager.scheduleReload();
    wsLogger.debug({ serverId }, 'Scheduled debounced Caddy reload after route updates');
  }

  io.to('authenticated').emit('server:status', {
    serverId,
    timestamp: report.timestamp,
    metrics: report.metrics,
    networkInfo: report.networkInfo,
    apps: report.apps,
  });
}
