/**
 * Deployment lifecycle operations (start/stop/restart).
 * Extracted from deployer.ts for better modularity.
 */

import { v4 as uuidv4 } from 'uuid';
import { sendCommand, requireAgentConnected } from '../websocket/agentHandler.js';
import { proxyManager } from './proxyManager.js';
import { setDeploymentStatus } from '../lib/deploymentHelpers.js';
import { auditService } from './auditService.js';
import logger from '../lib/logger.js';
import type { Deployment } from '@ownprem/shared';

/**
 * Start a deployment - enables proxy routes and sends start command.
 */
export async function startDeployment(
  deployment: Deployment,
  getDeployment: (id: string) => Promise<Deployment | null>
): Promise<Deployment> {
  requireAgentConnected(deployment.serverId);

  // Enable proxy routes (web UI and service routes) and reload Caddy
  await proxyManager.setRouteActive(deployment.id, true);
  await proxyManager.setServiceRoutesActiveByDeployment(deployment.id, true);
  const caddySuccess = await proxyManager.updateAndReload();

  if (!caddySuccess) {
    // Revert route state on Caddy failure
    await proxyManager.setRouteActive(deployment.id, false);
    await proxyManager.setServiceRoutesActiveByDeployment(deployment.id, false);
    logger.error({ deploymentId: deployment.id }, 'Failed to update Caddy configuration during start');
    throw new Error('Failed to update proxy configuration. App may not be accessible.');
  }

  setDeploymentStatus(deployment.id, 'running');

  // Send start command
  const commandId = uuidv4();
  sendCommand(deployment.serverId, {
    id: commandId,
    action: 'start',
    appName: deployment.appName,
  }, deployment.id);

  auditService.log({
    action: 'deployment_started',
    resourceType: 'deployment',
    resourceId: deployment.id,
    details: { appName: deployment.appName, serverId: deployment.serverId },
  });

  return (await getDeployment(deployment.id))!;
}

/**
 * Stop a deployment - disables proxy routes and sends stop command.
 */
export async function stopDeployment(
  deployment: Deployment,
  getDeployment: (id: string) => Promise<Deployment | null>
): Promise<Deployment> {
  requireAgentConnected(deployment.serverId);

  setDeploymentStatus(deployment.id, 'stopped');

  // Disable proxy routes (web UI and service routes) and reload Caddy
  await proxyManager.setRouteActive(deployment.id, false);
  await proxyManager.setServiceRoutesActiveByDeployment(deployment.id, false);
  const caddySuccess = await proxyManager.updateAndReload();

  if (!caddySuccess) {
    // Log warning but don't fail stop - stopping the app is more important
    // The route will be disabled in DB even if Caddy didn't reload
    logger.warn(
      { deploymentId: deployment.id },
      'Failed to update Caddy configuration during stop. Routes may remain active until next reload.'
    );
  }

  // Send stop command
  const commandId = uuidv4();
  sendCommand(deployment.serverId, {
    id: commandId,
    action: 'stop',
    appName: deployment.appName,
  }, deployment.id);

  auditService.log({
    action: 'deployment_stopped',
    resourceType: 'deployment',
    resourceId: deployment.id,
    details: { appName: deployment.appName, serverId: deployment.serverId },
  });

  return (await getDeployment(deployment.id))!;
}

/**
 * Restart a deployment - sends restart command without route changes.
 */
export async function restartDeployment(deployment: Deployment): Promise<Deployment> {
  requireAgentConnected(deployment.serverId);

  // Send restart command
  const commandId = uuidv4();
  sendCommand(deployment.serverId, {
    id: commandId,
    action: 'restart',
    appName: deployment.appName,
  }, deployment.id);

  auditService.log({
    action: 'deployment_restarted',
    resourceType: 'deployment',
    resourceId: deployment.id,
    details: { appName: deployment.appName, serverId: deployment.serverId },
  });

  return deployment;
}

/**
 * Update proxy routes state for a deployment.
 */
export async function setProxyRoutesActive(deploymentId: string, active: boolean): Promise<boolean> {
  await proxyManager.setRouteActive(deploymentId, active);
  await proxyManager.setServiceRoutesActiveByDeployment(deploymentId, active);
  return await proxyManager.updateAndReload();
}
