import { v4 as uuidv4 } from 'uuid';
import { readFile } from 'fs/promises';
import { getDb, runInTransaction } from '../db/index.js';
import { secretsManager } from './secretsManager.js';
import { configRenderer } from './configRenderer.js';
import { serviceRegistry } from './serviceRegistry.js';
import { dependencyResolver } from './dependencyResolver.js';
import { proxyManager } from './proxyManager.js';
import { caddyHAManager } from './caddyHAManager.js';
import { sendCommand, sendCommandAndWait, requireAgentConnected } from '../websocket/agentHandler.js';
import { mutexManager } from '../lib/mutexManager.js';
import logger from '../lib/logger.js';
import { setDeploymentStatus, updateDeploymentStatus } from '../lib/deploymentHelpers.js';
import { auditService } from './auditService.js';
import { getAppInfo, checkCanUninstall, validateInstall } from './deploymentValidator.js';
import { startDeployment, stopDeployment, restartDeployment } from './deploymentLifecycle.js';
import type { AppManifest, Deployment, DeploymentStatus, ConfigFile } from '@ownprem/shared';

// CA certificate paths to check (in order of preference)
const CA_CERT_PATHS = [
  '/etc/step-ca/root_ca.crt',           // Step-CA root (preferred)
  '/etc/caddy/ca-root.crt',             // Copied step-ca root
  '/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt',  // Caddy internal CA
];

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
  system: number;
  mandatory: number;
  singleton: number;
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
    requireAgentConnected(serverId);

    // Run all pre-install validations
    const { appInfo } = await validateInstall(serverId, appName);
    const manifest = appInfo.manifest;

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

      // For Caddy deployments, include the CA root certificate so it can trust step-ca
      if (appName === 'ownprem-caddy') {
        const caCert = await this.getCACertificate();
        if (caCert) {
          configFiles.push({
            path: '/etc/caddy/ca-root.crt',
            content: caCert,
            mode: '0644',
          });
          logger.info({ deploymentId }, 'Including CA root certificate for Caddy deployment');
        }
      }

      // Build environment variables for install
      const env: Record<string, string> = {
        SERVER_ID: serverId,
        APP_NAME: appName,
        APP_VERSION: appVersion,
      };

      // Build metadata for the app (used by agent for status reporting and privileged setup)
      const metadata: Record<string, unknown> = {
        name: appName,
        displayName: manifest.displayName,
        version: appVersion,
        serviceName: manifest.logging?.serviceName || appName,
        // Privileged setup info
        serviceUser: manifest.serviceUser,
        serviceGroup: manifest.serviceGroup || manifest.serviceUser,
        dataDirectories: manifest.dataDirectories,
        capabilities: manifest.capabilities,
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

      // Step 2: Send install command to agent and wait for completion
      // We must await this to ensure install succeeds before registering routes,
      // otherwise a failed install would leave orphaned proxy routes
      const commandId = uuidv4();
      logger.info({ deploymentId, appName, serverId }, 'Sending install command to agent');

      let installResult;
      try {
        installResult = await sendCommandAndWait(serverId, {
          id: commandId,
          action: 'install',
          appName,
          payload: {
            version: appVersion,
            files: configFiles,
            env,
            metadata,
          },
        }, deploymentId);
      } catch (err) {
        // Agent disconnected or command failed
        throw new Error(`Install command failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (installResult.status !== 'success') {
        throw new Error(`Install failed on agent: ${installResult.message || 'Unknown error'}`);
      }

      logger.info({ deploymentId, appName }, 'Install command completed successfully');

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

      // Auto-register Caddy deployments with HA manager
      if (appName === 'ownprem-caddy') {
        try {
          await caddyHAManager.registerInstance(deploymentId, {
            adminApiUrl: `http://${serverHost}:2019`,
          });
          logger.info({ deploymentId }, 'Auto-registered Caddy instance with HA manager');
        } catch (err) {
          // Don't fail deployment if HA registration fails
          logger.warn({ deploymentId, err }, 'Failed to auto-register Caddy instance with HA manager');
        }
      }

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

    requireAgentConnected(deployment.serverId);

    // Get manifest
    const appRow = db.prepare('SELECT manifest FROM app_registry WHERE name = ?').get(deployment.appName) as AppRegistryRow;
    let manifest: AppManifest;
    try {
      manifest = JSON.parse(appRow.manifest) as AppManifest;
    } catch (e) {
      throw new Error(`Failed to parse manifest for app ${deployment.appName}: ${e instanceof Error ? e.message : String(e)}`);
    }

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
    return startDeployment(deployment, this.getDeployment.bind(this));
  }

  async stop(deploymentId: string): Promise<Deployment> {
    const deployment = await this.getDeployment(deploymentId);
    if (!deployment) {
      throw new Error('Deployment not found');
    }
    return stopDeployment(deployment, this.getDeployment.bind(this));
  }

  async restart(deploymentId: string): Promise<Deployment> {
    const deployment = await this.getDeployment(deploymentId);
    if (!deployment) {
      throw new Error('Deployment not found');
    }
    return restartDeployment(deployment);
  }

  async uninstall(deploymentId: string): Promise<void> {
    const deployment = await this.getDeployment(deploymentId);
    if (!deployment) {
      throw new Error('Deployment not found');
    }

    requireAgentConnected(deployment.serverId);

    const db = getDb();

    // Check if this is a mandatory app on the core server
    checkCanUninstall(deployment.appName, deployment.serverId);

    // Update status to uninstalling first
    setDeploymentStatus(deploymentId, 'uninstalling');

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

    // Unregister Caddy instance from HA manager if this is a Caddy deployment
    if (deployment.appName === 'ownprem-caddy') {
      try {
        const instance = await caddyHAManager.getInstanceByDeployment(deploymentId);
        if (instance) {
          await caddyHAManager.unregisterInstance(instance.id);
          logger.info({ deploymentId }, 'Unregistered Caddy instance from HA manager');
        }
      } catch (err) {
        logger.warn({ deploymentId, err }, 'Failed to unregister Caddy instance from HA manager');
      }
    }

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
    updateDeploymentStatus(deploymentId, status, message);
  }

  private rowToDeployment(row: DeploymentRow): Deployment {
    let config: Record<string, unknown>;
    let torAddresses: Record<string, string> | undefined;

    try {
      config = JSON.parse(row.config);
    } catch (e) {
      logger.error({ deploymentId: row.id, error: e }, 'Failed to parse deployment config JSON');
      config = {}; // Fallback to empty config
    }

    if (row.tor_addresses) {
      try {
        torAddresses = JSON.parse(row.tor_addresses);
      } catch (e) {
        logger.error({ deploymentId: row.id, error: e }, 'Failed to parse tor_addresses JSON');
        torAddresses = undefined;
      }
    }

    return {
      id: row.id,
      serverId: row.server_id,
      appName: row.app_name,
      groupId: row.group_id || undefined,
      version: row.version,
      config,
      status: row.status as DeploymentStatus,
      statusMessage: row.status_message || undefined,
      torAddresses,
      installedAt: new Date(row.installed_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * Get CA root certificate content for distribution to Caddy instances.
   * Returns null if no CA certificate is available.
   */
  private async getCACertificate(): Promise<string | null> {
    for (const certPath of CA_CERT_PATHS) {
      try {
        const content = await readFile(certPath, 'utf-8');
        logger.debug({ certPath }, 'Found CA certificate');
        return content;
      } catch {
        // Try next path
      }
    }
    logger.debug('No CA certificate found for distribution');
    return null;
  }
}

export const deployer = new Deployer();
