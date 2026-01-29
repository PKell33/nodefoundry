import { Router, Response, NextFunction } from 'express';
import { deployer } from '../../services/deployer.js';
import { dependencyResolver } from '../../services/dependencyResolver.js';
import { serviceRegistry } from '../../services/serviceRegistry.js';
import { getDb } from '../../db/index.js';
import { createError } from '../middleware/error.js';
import { validateBody, schemas } from '../middleware/validate.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { authService } from '../../services/authService.js';
import { requestLogs } from '../../websocket/agentHandler.js';
import { parsePaginationParams, paginateOrReturnAll } from '../../lib/pagination.js';
import type { AppManifest } from '@ownprem/shared';

const router = Router();

// Helper: Check if user can manage a deployment (deploy, delete, configure)
// For new deployments (POST), checks if user can manage the specified groupId
// For existing deployments, checks if user is admin for the deployment's group
async function canManageDeployment(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    return;
  }

  // System admins can do everything
  if (req.user.isSystemAdmin) {
    next();
    return;
  }

  // For POST requests (new deployments), check the groupId from body
  if (req.method === 'POST' && !req.params.id) {
    const groupId = req.body.groupId || 'default';
    const role = authService.getUserRoleInGroup(req.user.userId, groupId);
    if (role === 'admin') {
      next();
      return;
    }
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin permission required for this group' } });
    return;
  }

  // For existing deployments, check the deployment's group
  const deploymentId = req.params.id;
  if (deploymentId) {
    const deployment = await deployer.getDeployment(deploymentId);
    if (!deployment) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Deployment not found' } });
      return;
    }

    const groupId = deployment.groupId || 'default';
    const role = authService.getUserRoleInGroup(req.user.userId, groupId);
    if (role === 'admin') {
      next();
      return;
    }
  }

  res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin permission required for this group' } });
}

// Helper: Check if user can operate a deployment (start, stop, restart)
async function canOperateDeployment(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    return;
  }

  // System admins can do everything
  if (req.user.isSystemAdmin) {
    next();
    return;
  }

  // Get the deployment's group
  const deploymentId = req.params.id;
  const deployment = await deployer.getDeployment(deploymentId);
  if (!deployment) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Deployment not found' } });
    return;
  }

  const groupId = deployment.groupId || 'default';
  const role = authService.getUserRoleInGroup(req.user.userId, groupId);

  // Admin or operator in the deployment's group can operate
  if (role === 'admin' || role === 'operator') {
    next();
    return;
  }

  res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Operator permission required for this group' } });
}

interface AppRegistryRow {
  name: string;
  manifest: string;
}

// GET /api/deployments - List all deployments (filtered by user's groups)
router.get('/', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const serverId = req.query.serverId as string | undefined;
    let deployments = await deployer.listDeployments(serverId);

    // System admins see everything
    if (!req.user?.isSystemAdmin) {
      // Get user's groups
      const userGroups = authService.getUserGroups(req.user!.userId);
      const userGroupIds = new Set(userGroups.map(g => g.groupId));

      // Filter deployments to only those in user's groups
      deployments = deployments.filter(d => {
        const groupId = d.groupId || 'default';
        return userGroupIds.has(groupId);
      });
    }

    // Apply pagination if requested, otherwise return full array for backward compatibility
    const paginationParams = parsePaginationParams(req);
    res.json(paginateOrReturnAll(deployments, paginationParams));
  } catch (err) {
    next(err);
  }
});

// POST /api/deployments - Install an app (admin for the group)
router.post('/', requireAuth, validateBody(schemas.deployments.create), canManageDeployment, async (req, res, next) => {
  try {
    const { serverId, appName, config, version, groupId, serviceBindings } = req.body;
    const deployment = await deployer.install(serverId, appName, config || {}, version, groupId, serviceBindings);
    res.status(201).json(deployment);
  } catch (err) {
    next(err);
  }
});

// POST /api/deployments/validate - Validate before install
router.post('/validate', requireAuth, validateBody(schemas.deployments.validate), async (req, res, next) => {
  try {
    const { serverId, appName } = req.body;

    const db = getDb();
    const appRow = db.prepare('SELECT manifest FROM app_registry WHERE name = ?').get(appName) as AppRegistryRow | undefined;

    if (!appRow) {
      throw createError(`App ${appName} not found`, 404, 'APP_NOT_FOUND');
    }

    const manifest = JSON.parse(appRow.manifest) as AppManifest;
    const validation = await dependencyResolver.validate(manifest, serverId);

    // Get dependency info
    const dependencies = [];
    for (const req of manifest.requires || []) {
      const providers = await dependencyResolver.getServiceProviders(req.service);
      dependencies.push({
        service: req.service,
        optional: req.optional || false,
        locality: req.locality,
        providers,
        satisfied: providers.length > 0,
      });
    }

    res.json({
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
      dependencies,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/deployments/:id - Get deployment details (only if user has access to the group)
router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const deployment = await deployer.getDeployment(req.params.id);

    if (!deployment) {
      throw createError('Deployment not found', 404, 'DEPLOYMENT_NOT_FOUND');
    }

    // Check if user has access to this deployment's group
    if (!req.user?.isSystemAdmin) {
      const groupId = deployment.groupId || 'default';
      const role = authService.getUserRoleInGroup(req.user!.userId, groupId);
      if (!role) {
        throw createError('Deployment not found', 404, 'DEPLOYMENT_NOT_FOUND');
      }
    }

    // Get services provided by this deployment
    const services = await serviceRegistry.getServicesByDeployment(deployment.id);

    res.json({
      ...deployment,
      services,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/deployments/:id - Update deployment config (admin for the group)
router.put('/:id', requireAuth, canManageDeployment, async (req, res, next) => {
  try {
    const { config } = req.body;

    if (!config || typeof config !== 'object') {
      throw createError('config object is required', 400, 'INVALID_CONFIG');
    }

    const deployment = await deployer.configure(req.params.id, config);
    res.json(deployment);
  } catch (err) {
    next(err);
  }
});

// POST /api/deployments/:id/start - Start the app (admin or operator for the group)
router.post('/:id/start', requireAuth, canOperateDeployment, async (req, res, next) => {
  try {
    const deployment = await deployer.start(req.params.id);
    res.json(deployment);
  } catch (err) {
    next(err);
  }
});

// POST /api/deployments/:id/stop - Stop the app (admin or operator for the group)
router.post('/:id/stop', requireAuth, canOperateDeployment, async (req, res, next) => {
  try {
    const deployment = await deployer.stop(req.params.id);
    res.json(deployment);
  } catch (err) {
    next(err);
  }
});

// POST /api/deployments/:id/restart - Restart the app (admin or operator for the group)
router.post('/:id/restart', requireAuth, canOperateDeployment, async (req, res, next) => {
  try {
    const deployment = await deployer.restart(req.params.id);
    res.json(deployment);
  } catch (err) {
    next(err);
  }
});

// GET /api/deployments/:id/logs - Get logs for the app (admin or operator for the group)
router.get('/:id/logs', requireAuth, canOperateDeployment, async (req: AuthenticatedRequest, res, next) => {
  try {
    const deployment = await deployer.getDeployment(req.params.id);
    if (!deployment) {
      throw createError('Deployment not found', 404, 'DEPLOYMENT_NOT_FOUND');
    }

    // Get the manifest for logging config
    const db = getDb();
    const appRow = db.prepare('SELECT manifest FROM app_registry WHERE name = ?').get(deployment.appName) as AppRegistryRow | undefined;
    const manifest = appRow ? JSON.parse(appRow.manifest) as AppManifest : null;

    // Parse query params
    const lines = Math.min(parseInt(req.query.lines as string) || 100, 1000);
    const since = req.query.since as string | undefined;
    const grep = req.query.grep as string | undefined;

    // Request logs from the agent
    const result = await requestLogs(deployment.serverId, deployment.appName, {
      lines,
      since,
      grep,
      logPath: manifest?.logging?.logFile,
      serviceName: manifest?.logging?.serviceName,
    });

    res.json({
      appName: deployment.appName,
      serverId: deployment.serverId,
      logs: result.logs,
      source: result.source,
      hasMore: result.hasMore,
      status: result.status,
      message: result.message,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/deployments/:id - Uninstall the app (admin for the group)
router.delete('/:id', requireAuth, canManageDeployment, async (req, res, next) => {
  try {
    await deployer.uninstall(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/deployments/:id/connection-info - Get connection details and credentials
router.get('/:id/connection-info', requireAuth, canManageDeployment, async (req: AuthenticatedRequest, res, next) => {
  try {
    const deployment = await deployer.getDeployment(req.params.id);
    if (!deployment) {
      throw createError('Deployment not found', 404, 'DEPLOYMENT_NOT_FOUND');
    }

    // Get the app manifest
    const db = getDb();
    const appRow = db.prepare('SELECT manifest FROM app_registry WHERE name = ?').get(deployment.appName) as AppRegistryRow | undefined;
    if (!appRow) {
      throw createError('App not found', 404, 'APP_NOT_FOUND');
    }
    const manifest = JSON.parse(appRow.manifest) as AppManifest;

    // Get services provided by this deployment
    const services = await serviceRegistry.getServicesByDeployment(deployment.id);

    // Get decrypted credentials (may fail if secrets key changed)
    const { secretsManager } = await import('../../services/secretsManager.js');
    const { proxyManager } = await import('../../services/proxyManager.js');
    let secrets: Record<string, unknown> | null = null;
    try {
      secrets = await secretsManager.getSecrets(deployment.id);
    } catch (err) {
      console.warn('Failed to decrypt secrets for deployment', deployment.id, err);
      // Continue without credentials - they may need to be regenerated
    }

    // Build connection info for each service
    const connectionInfo = await Promise.all(services.map(async service => {
      // Find the service definition in manifest to get credential field info
      const serviceDef = manifest.provides?.find(p => p.name === service.serviceName);

      // Get credentials for this service if defined
      let credentials: Record<string, string> | undefined;
      if (serviceDef?.credentials && secrets) {
        credentials = {};
        for (const field of serviceDef.credentials.fields || []) {
          if (secrets[field]) {
            credentials[field] = String(secrets[field]);
          }
        }
      }

      // Get the proxied route info
      const serviceRoute = await proxyManager.getServiceRoute(service.id);

      // Build external connection details (through Caddy proxy)
      let externalHost: string;
      let externalPort: number | undefined;
      let externalPath: string | undefined;

      if (serviceRoute) {
        if (serviceRoute.routeType === 'http') {
          externalHost = 'ownprem.local';
          externalPath = serviceRoute.externalPath;
        } else {
          externalHost = 'ownprem.local';
          externalPort = serviceRoute.externalPort;
        }
      } else {
        // Fallback to direct connection if no route registered
        externalHost = service.host;
        externalPort = service.port;
      }

      return {
        serviceName: service.serviceName,
        protocol: serviceDef?.protocol || 'tcp',
        // Proxied connection (recommended)
        host: externalHost,
        port: externalPort || service.port,
        path: externalPath,
        // Direct connection (internal use only)
        directHost: service.host,
        directPort: service.port,
        // Tor connection (bypasses Caddy)
        torAddress: service.torAddress,
        credentials,
      };
    }));

    res.json({
      appName: deployment.appName,
      displayName: manifest.displayName,
      serverId: deployment.serverId,
      status: deployment.status,
      services: connectionInfo,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
