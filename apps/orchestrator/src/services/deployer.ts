import { v4 as uuidv4 } from 'uuid';
import { getDb, runInTransaction } from '../db/index.js';
import { secretsManager } from './secretsManager.js';
import { configRenderer } from './configRenderer.js';
import { serviceRegistry } from './serviceRegistry.js';
import { dependencyResolver } from './dependencyResolver.js';
import { proxyManager } from './proxyManager.js';
import { sendCommand, isAgentConnected } from '../websocket/agentHandler.js';
import { mutexManager } from '../lib/mutexManager.js';
import logger from '../lib/logger.js';
import { auditService } from './auditService.js';
import type { AppManifest, Deployment, DeploymentStatus, ConfigFile } from '@ownprem/shared';

// Type for compensating transactions (rollback functions)
type CompensationFn = () => Promise<void>;

interface DeploymentRow {
  id: string;
  server_id: string;
  app_name: string;
  group_id: string | null;
  version: string;
  config: string;
  status: string;
  status_message: string | null;
  tor_addresses: string | null;
  installed_at: string;
  updated_at: string;
}

interface AppRegistryRow {
  name: string;
  manifest: string;
}

interface ServerRow {
  id: string;
  host: string | null;
  is_core: number;
}

export class Deployer {
  async install(
    serverId: string,
    appName: string,
    userConfig: Record<string, unknown> = {},
    version?: string,
    groupId?: string,
    serviceBindings?: Record<string, string>
  ): Promise<Deployment> {
    const db = getDb();

    // Check if agent is connected
    if (!isAgentConnected(serverId)) {
      throw new Error(`Server ${serverId} is not connected`);
    }

    // Get app manifest
    const appRow = db.prepare('SELECT manifest FROM app_registry WHERE name = ?').get(appName) as AppRegistryRow | undefined;
    if (!appRow) {
      throw new Error(`App ${appName} not found in registry`);
    }
    const manifest = JSON.parse(appRow.manifest) as AppManifest;

    // Check for existing deployment
    const existing = db.prepare('SELECT id FROM deployments WHERE server_id = ? AND app_name = ?').get(serverId, appName);
    if (existing) {
      throw new Error(`App ${appName} is already deployed on ${serverId}`);
    }

    // Check for conflicts with already installed apps
    if (manifest.conflicts && manifest.conflicts.length > 0) {
      const placeholders = manifest.conflicts.map(() => '?').join(',');
      const conflicting = db.prepare(`
        SELECT app_name FROM deployments
        WHERE server_id = ? AND app_name IN (${placeholders})
      `).get(serverId, ...manifest.conflicts) as { app_name: string } | undefined;

      if (conflicting) {
        throw new Error(`Cannot install ${appName}: conflicts with ${conflicting.app_name} already installed on this server`);
      }
    }

    // Validate dependencies
    const validation = await dependencyResolver.validate(manifest, serverId);
    if (!validation.valid) {
      throw new Error(`Dependency validation failed: ${validation.errors.join(', ')}`);
    }

    // Log warnings
    for (const warning of validation.warnings) {
      console.warn(`[${appName}] ${warning}`);
    }

    // Resolve full config (user config + dependencies + defaults)
    const resolvedConfig = await dependencyResolver.resolve(manifest, serverId, userConfig);

    // Generate secrets for fields marked as generated
    const secrets: Record<string, string> = {};
    for (const field of manifest.configSchema) {
      if (field.generated && field.secret) {
        if (field.type === 'password') {
          secrets[field.name] = secretsManager.generatePassword();
        } else if (field.name.toLowerCase().includes('user')) {
          secrets[field.name] = secretsManager.generateUsername(appName);
        } else {
          secrets[field.name] = secretsManager.generatePassword(16);
        }
      }
    }

    // Create deployment record
    const deploymentId = uuidv4();
    const appVersion = version || manifest.version;

    // Use default group if none specified
    const finalGroupId = groupId || 'default';

    // Get server info for config rendering (needed before transaction)
    const server = db.prepare('SELECT host, is_core FROM servers WHERE id = ?').get(serverId) as ServerRow;
    const serverHost = server.is_core ? '127.0.0.1' : (server.host || '127.0.0.1');

    // Compensating transactions for rollback on failure
    const compensations: CompensationFn[] = [];

    /**
     * Execute all compensations in reverse order.
     * Logs errors but doesn't throw to ensure all compensations run.
     */
    const rollback = async (error: Error): Promise<never> => {
      logger.error({ deploymentId, appName, err: error }, 'Install failed, rolling back');
      for (const compensate of compensations.reverse()) {
        try {
          await compensate();
        } catch (compensationError) {
          logger.error({ deploymentId, err: compensationError }, 'Compensation failed during rollback');
        }
      }
      throw error;
    };

    try {
      // Step 1: Create deployment record and secrets (atomic transaction)
      runInTransaction(() => {
        db.prepare(`
          INSERT INTO deployments (id, server_id, app_name, group_id, version, config, status, installed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'installing', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(deploymentId, serverId, appName, finalGroupId, appVersion, JSON.stringify(resolvedConfig));

        // Store secrets synchronously within transaction
        if (Object.keys(secrets).length > 0) {
          secretsManager.storeSecretsSync(deploymentId, secrets);
        }
      });
      compensations.push(async () => {
        logger.debug({ deploymentId }, 'Rolling back: deleting deployment and secrets');
        runInTransaction(() => {
          secretsManager.deleteSecretsSync(deploymentId);
          db.prepare('DELETE FROM deployments WHERE id = ?').run(deploymentId);
        });
      });

      // Render config files
      const configFiles = await configRenderer.renderAppConfigs(manifest, resolvedConfig, secrets);

      // Add install script
      const installScript = configRenderer.renderInstallScript(manifest, resolvedConfig);
      if (installScript) {
        configFiles.push(installScript);
      }

      // Add configure script
      const configureScript = configRenderer.renderConfigureScript(manifest);
      if (configureScript) {
        configFiles.push(configureScript);
      }

      // Add uninstall script
      const uninstallScript = configRenderer.renderUninstallScript(manifest);
      if (uninstallScript) {
        configFiles.push(uninstallScript);
      }

      // Add start script
      const startScript = configRenderer.renderStartScript(manifest);
      if (startScript) {
        configFiles.push(startScript);
      }

      // Add stop script
      const stopScript = configRenderer.renderStopScript(manifest);
      if (stopScript) {
        configFiles.push(stopScript);
      }

      // Build environment variables for install
      const env: Record<string, string> = {
        SERVER_ID: serverId,
        APP_NAME: appName,
        APP_VERSION: appVersion,
      };

      // Add non-secret config to env
      for (const [key, value] of Object.entries(resolvedConfig)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          env[key.toUpperCase()] = String(value);
        }
      }

      // Add secrets to env
      for (const [key, value] of Object.entries(secrets)) {
        env[key.toUpperCase()] = value;
      }

      // Step 2: Send install command to agent
      const commandId = uuidv4();
      const sent = sendCommand(serverId, {
        id: commandId,
        action: 'install',
        appName,
        payload: {
          version: appVersion,
          files: configFiles,
          env,
        },
      }, deploymentId);

      if (!sent) {
        throw new Error(`Failed to send install command to ${serverId}`);
      }

      // Step 3: Register services and their proxy routes
      const registeredServiceIds: string[] = [];
      for (const serviceDef of manifest.provides || []) {
        const service = await serviceRegistry.registerService(deploymentId, serviceDef.name, serverId, serviceDef.port);
        registeredServiceIds.push(service.id);

        // Register service route through Caddy proxy
        await proxyManager.registerServiceRoute(
          service.id,
          serviceDef.name,
          serviceDef,
          serverHost,
          serviceDef.port
        );
      }
      if (registeredServiceIds.length > 0) {
        compensations.push(async () => {
          logger.debug({ deploymentId }, 'Rolling back: unregistering services and routes');
          await proxyManager.unregisterServiceRoutesByDeployment(deploymentId);
          serviceRegistry.unregisterServicesSync(deploymentId);
        });
      }

      // Step 4: Register proxy route if app has webui
      if (manifest.webui?.enabled) {
        await proxyManager.registerRoute(deploymentId, manifest, serverHost);
        compensations.push(async () => {
          logger.debug({ deploymentId }, 'Rolling back: unregistering web UI route');
          await proxyManager.unregisterRoute(deploymentId);
        });
      }

      // Step 5: Update Caddy config and reload
      const caddySuccess = await proxyManager.updateAndReload();
      if (!caddySuccess) {
        throw new Error('Failed to update Caddy configuration');
      }

      // Audit log
      auditService.log({
        action: 'deployment_installed',
        resourceType: 'deployment',
        resourceId: deploymentId,
        details: { appName, serverId, version: appVersion },
      });

      return (await this.getDeployment(deploymentId))!;
    } catch (error) {
      return rollback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async configure(deploymentId: string, newConfig: Record<string, unknown>): Promise<Deployment> {
    const db = getDb();
    const deployment = await this.getDeployment(deploymentId);

    if (!deployment) {
      throw new Error('Deployment not found');
    }

    if (!isAgentConnected(deployment.serverId)) {
      throw new Error(`Server ${deployment.serverId} is not connected`);
    }

    // Get manifest
    const appRow = db.prepare('SELECT manifest FROM app_registry WHERE name = ?').get(deployment.appName) as AppRegistryRow;
    const manifest = JSON.parse(appRow.manifest) as AppManifest;

    // Merge config
    const mergedConfig = { ...deployment.config, ...newConfig };

    // Get secrets
    const secrets = await secretsManager.getSecrets(deploymentId) || {};

    // Render config files
    const configFiles = await configRenderer.renderAppConfigs(manifest, mergedConfig, secrets);

    // Update deployment
    db.prepare(`
      UPDATE deployments SET config = ?, status = 'configuring', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(mergedConfig), deploymentId);

    // Send configure command
    const commandId = uuidv4();
    sendCommand(deployment.serverId, {
      id: commandId,
      action: 'configure',
      appName: deployment.appName,
      payload: {
        files: configFiles,
      },
    }, deploymentId);

    return (await this.getDeployment(deploymentId))!;
  }

  async start(deploymentId: string): Promise<Deployment> {
    const deployment = await this.getDeployment(deploymentId);
    if (!deployment) {
      throw new Error('Deployment not found');
    }

    if (!isAgentConnected(deployment.serverId)) {
      throw new Error(`Server ${deployment.serverId} is not connected`);
    }

    const db = getDb();
    db.prepare(`
      UPDATE deployments SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(deploymentId);

    // Enable proxy route
    await proxyManager.setRouteActive(deploymentId, true);

    // Send start command
    const commandId = uuidv4();
    sendCommand(deployment.serverId, {
      id: commandId,
      action: 'start',
      appName: deployment.appName,
    }, deploymentId);

    auditService.log({
      action: 'deployment_started',
      resourceType: 'deployment',
      resourceId: deploymentId,
      details: { appName: deployment.appName, serverId: deployment.serverId },
    });

    return (await this.getDeployment(deploymentId))!;
  }

  async stop(deploymentId: string): Promise<Deployment> {
    const deployment = await this.getDeployment(deploymentId);
    if (!deployment) {
      throw new Error('Deployment not found');
    }

    if (!isAgentConnected(deployment.serverId)) {
      throw new Error(`Server ${deployment.serverId} is not connected`);
    }

    const db = getDb();
    db.prepare(`
      UPDATE deployments SET status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(deploymentId);

    // Disable proxy route
    await proxyManager.setRouteActive(deploymentId, false);

    // Send stop command
    const commandId = uuidv4();
    sendCommand(deployment.serverId, {
      id: commandId,
      action: 'stop',
      appName: deployment.appName,
    }, deploymentId);

    auditService.log({
      action: 'deployment_stopped',
      resourceType: 'deployment',
      resourceId: deploymentId,
      details: { appName: deployment.appName, serverId: deployment.serverId },
    });

    return (await this.getDeployment(deploymentId))!;
  }

  async restart(deploymentId: string): Promise<Deployment> {
    const deployment = await this.getDeployment(deploymentId);
    if (!deployment) {
      throw new Error('Deployment not found');
    }

    if (!isAgentConnected(deployment.serverId)) {
      throw new Error(`Server ${deployment.serverId} is not connected`);
    }

    // Send restart command
    const commandId = uuidv4();
    sendCommand(deployment.serverId, {
      id: commandId,
      action: 'restart',
      appName: deployment.appName,
    }, deploymentId);

    auditService.log({
      action: 'deployment_restarted',
      resourceType: 'deployment',
      resourceId: deploymentId,
      details: { appName: deployment.appName, serverId: deployment.serverId },
    });

    return deployment;
  }

  async uninstall(deploymentId: string): Promise<void> {
    const deployment = await this.getDeployment(deploymentId);
    if (!deployment) {
      throw new Error('Deployment not found');
    }

    if (!isAgentConnected(deployment.serverId)) {
      throw new Error(`Server ${deployment.serverId} is not connected`);
    }

    const db = getDb();

    // Update status to uninstalling first
    db.prepare(`
      UPDATE deployments SET status = 'uninstalling', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(deploymentId);

    // Send uninstall command
    const commandId = uuidv4();
    sendCommand(deployment.serverId, {
      id: commandId,
      action: 'uninstall',
      appName: deployment.appName,
    }, deploymentId);

    // Remove proxy routes (DB operations, done before transaction to use async proxyManager)
    await proxyManager.unregisterRoute(deploymentId);
    await proxyManager.unregisterServiceRoutesByDeployment(deploymentId);

    // Atomic transaction: services + secrets + deployment deletion
    runInTransaction(() => {
      // Remove services
      serviceRegistry.unregisterServicesSync(deploymentId);

      // Delete secrets
      secretsManager.deleteSecretsSync(deploymentId);

      // Delete deployment record
      db.prepare('DELETE FROM deployments WHERE id = ?').run(deploymentId);
    });

    // Clean up deployment mutex to prevent memory leak
    mutexManager.cleanupDeploymentMutex(deploymentId);

    // Update Caddy config and reload (external operation, outside transaction)
    await proxyManager.updateAndReload();

    auditService.log({
      action: 'deployment_uninstalled',
      resourceType: 'deployment',
      resourceId: deploymentId,
      details: { appName: deployment.appName, serverId: deployment.serverId },
    });
  }

  async getDeployment(deploymentId: string): Promise<Deployment | null> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM deployments WHERE id = ?').get(deploymentId) as DeploymentRow | undefined;

    if (!row) {
      return null;
    }

    return this.rowToDeployment(row);
  }

  async listDeployments(serverId?: string): Promise<Deployment[]> {
    const db = getDb();
    let rows: DeploymentRow[];

    if (serverId) {
      rows = db.prepare('SELECT * FROM deployments WHERE server_id = ? ORDER BY app_name').all(serverId) as DeploymentRow[];
    } else {
      rows = db.prepare('SELECT * FROM deployments ORDER BY server_id, app_name').all() as DeploymentRow[];
    }

    return rows.map(row => this.rowToDeployment(row));
  }

  async updateStatus(deploymentId: string, status: DeploymentStatus, message?: string): Promise<void> {
    const db = getDb();
    db.prepare(`
      UPDATE deployments SET status = ?, status_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, message || null, deploymentId);
  }

  private rowToDeployment(row: DeploymentRow): Deployment {
    return {
      id: row.id,
      serverId: row.server_id,
      appName: row.app_name,
      groupId: row.group_id || undefined,
      version: row.version,
      config: JSON.parse(row.config),
      status: row.status as DeploymentStatus,
      statusMessage: row.status_message || undefined,
      torAddresses: row.tor_addresses ? JSON.parse(row.tor_addresses) : undefined,
      installedAt: new Date(row.installed_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export const deployer = new Deployer();
