/**
 * Docker Deployer Service
 *
 * Manages Docker app deployments from the Umbrel App Store.
 * Transforms docker-compose.yml, generates secrets, and coordinates with agents.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { DeploymentRow, ExistsRow } from '../db/types.js';
import logger from '../lib/logger.js';
import { appStoreService, type AppDefinition } from './appStoreService.js';
import { sendCommandAndWait, isAgentConnected } from '../websocket/agentHandler.js';
import { secretsManager } from './secretsManager.js';
import type { CommandResult, DockerDeployResult } from '@ownprem/shared';

interface ComposeService {
  image?: string;
  container_name?: string;
  environment?: Record<string, string> | string[];
  volumes?: string[];
  ports?: string[];
  depends_on?: string[] | Record<string, unknown>;
  restart?: string;
  network_mode?: string;
  [key: string]: unknown;
}

interface ComposeFile {
  version?: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, unknown>;
}

export interface DeployOptions {
  serverId: string;
  appId: string;
  config?: Record<string, unknown>;
}

export interface DeploymentInfo {
  id: string;
  serverId: string;
  appId: string;
  appName: string;
  version: string;
  status: 'pending' | 'installing' | 'running' | 'stopped' | 'error';
  statusMessage?: string;
  installedAt: Date;
  updatedAt: Date;
}

class DockerDeployer {
  /**
   * Deploy an app to a server
   */
  async deploy(options: DeployOptions): Promise<DeploymentInfo> {
    const { serverId, appId, config = {} } = options;
    const db = getDb();

    // Check if agent is connected
    if (!isAgentConnected(serverId)) {
      throw new Error(`Server ${serverId} is not connected`);
    }

    // Get app definition
    const app = await appStoreService.getApp(appId);
    if (!app) {
      throw new Error(`App ${appId} not found in app store`);
    }

    // Check for existing deployment
    const existing = db.prepare(`
      SELECT id FROM deployments WHERE server_id = ? AND app_name = ?
    `).get(serverId, appId) as ExistsRow | undefined;

    if (existing) {
      throw new Error(`App ${appId} is already deployed on server ${serverId}`);
    }

    const deploymentId = uuidv4();
    logger.info({ deploymentId, serverId, appId }, 'Starting Docker deployment');

    // Create deployment record
    db.prepare(`
      INSERT INTO deployments (id, server_id, app_name, version, config, status, status_message)
      VALUES (?, ?, ?, ?, ?, 'pending', 'Preparing deployment')
    `).run(deploymentId, serverId, appId, app.version, JSON.stringify(config));

    try {
      // Update status to installing
      this.updateStatus(deploymentId, 'installing', 'Generating configuration');

      // Generate secrets for the app
      const secrets = await this.generateSecrets(deploymentId, app);

      // Transform compose file
      const transformedCompose = this.transformComposeFile(app.composeFile, app, secrets, serverId);

      // Update status
      this.updateStatus(deploymentId, 'installing', 'Deploying containers');

      // Send deploy command to agent
      const commandId = uuidv4();
      const result = await sendCommandAndWait(serverId, {
        id: commandId,
        action: 'docker:deploy',
        appName: appId,
        payload: {
          docker: {
            appId,
            composeYaml: transformedCompose,
          },
        },
      }, deploymentId);

      if (result.status === 'error') {
        throw new Error(result.message || 'Deployment failed');
      }

      const deployResult = result.data as DockerDeployResult | undefined;
      if (deployResult && !deployResult.success) {
        throw new Error(deployResult.error || 'Deployment failed');
      }

      // Update status to running
      this.updateStatus(deploymentId, 'running', null);

      logger.info({ deploymentId, serverId, appId, containers: deployResult?.containers }, 'Docker deployment complete');

      return this.getDeployment(deploymentId)!;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateStatus(deploymentId, 'error', message);
      logger.error({ deploymentId, serverId, appId, error: message }, 'Docker deployment failed');
      throw err;
    }
  }

  /**
   * Start a stopped deployment
   */
  async start(deploymentId: string): Promise<void> {
    const deployment = this.getDeploymentRow(deploymentId);
    if (!deployment) {
      throw new Error(`Deployment ${deploymentId} not found`);
    }

    if (!isAgentConnected(deployment.server_id)) {
      throw new Error(`Server ${deployment.server_id} is not connected`);
    }

    logger.info({ deploymentId, appId: deployment.app_name }, 'Starting Docker app');

    const commandId = uuidv4();
    const result = await sendCommandAndWait(deployment.server_id, {
      id: commandId,
      action: 'docker:start',
      appName: deployment.app_name,
      payload: {
        docker: { appId: deployment.app_name },
      },
    }, deploymentId);

    if (result.status === 'error') {
      throw new Error(result.message || 'Start failed');
    }

    this.updateStatus(deploymentId, 'running', null);
  }

  /**
   * Stop a running deployment
   */
  async stop(deploymentId: string): Promise<void> {
    const deployment = this.getDeploymentRow(deploymentId);
    if (!deployment) {
      throw new Error(`Deployment ${deploymentId} not found`);
    }

    if (!isAgentConnected(deployment.server_id)) {
      throw new Error(`Server ${deployment.server_id} is not connected`);
    }

    logger.info({ deploymentId, appId: deployment.app_name }, 'Stopping Docker app');

    const commandId = uuidv4();
    const result = await sendCommandAndWait(deployment.server_id, {
      id: commandId,
      action: 'docker:stop',
      appName: deployment.app_name,
      payload: {
        docker: { appId: deployment.app_name },
      },
    }, deploymentId);

    if (result.status === 'error') {
      throw new Error(result.message || 'Stop failed');
    }

    this.updateStatus(deploymentId, 'stopped', null);
  }

  /**
   * Restart a deployment
   */
  async restart(deploymentId: string): Promise<void> {
    const deployment = this.getDeploymentRow(deploymentId);
    if (!deployment) {
      throw new Error(`Deployment ${deploymentId} not found`);
    }

    if (!isAgentConnected(deployment.server_id)) {
      throw new Error(`Server ${deployment.server_id} is not connected`);
    }

    logger.info({ deploymentId, appId: deployment.app_name }, 'Restarting Docker app');

    const commandId = uuidv4();
    const result = await sendCommandAndWait(deployment.server_id, {
      id: commandId,
      action: 'docker:restart',
      appName: deployment.app_name,
      payload: {
        docker: { appId: deployment.app_name },
      },
    }, deploymentId);

    if (result.status === 'error') {
      throw new Error(result.message || 'Restart failed');
    }

    this.updateStatus(deploymentId, 'running', null);
  }

  /**
   * Uninstall a deployment
   */
  async uninstall(deploymentId: string): Promise<void> {
    const deployment = this.getDeploymentRow(deploymentId);
    if (!deployment) {
      throw new Error(`Deployment ${deploymentId} not found`);
    }

    if (!isAgentConnected(deployment.server_id)) {
      throw new Error(`Server ${deployment.server_id} is not connected`);
    }

    logger.info({ deploymentId, appId: deployment.app_name }, 'Uninstalling Docker app');

    const commandId = uuidv4();
    const result = await sendCommandAndWait(deployment.server_id, {
      id: commandId,
      action: 'docker:remove',
      appName: deployment.app_name,
      payload: {
        docker: { appId: deployment.app_name },
      },
    }, deploymentId);

    if (result.status === 'error') {
      throw new Error(result.message || 'Uninstall failed');
    }

    // Delete deployment record and secrets
    const db = getDb();
    db.prepare('DELETE FROM secrets WHERE deployment_id = ?').run(deploymentId);
    db.prepare('DELETE FROM deployments WHERE id = ?').run(deploymentId);

    logger.info({ deploymentId, appId: deployment.app_name }, 'Docker app uninstalled');
  }

  /**
   * Get logs for a deployment
   */
  async getLogs(deploymentId: string, lines: number = 100): Promise<string> {
    const deployment = this.getDeploymentRow(deploymentId);
    if (!deployment) {
      throw new Error(`Deployment ${deploymentId} not found`);
    }

    if (!isAgentConnected(deployment.server_id)) {
      throw new Error(`Server ${deployment.server_id} is not connected`);
    }

    const commandId = uuidv4();
    const result = await sendCommandAndWait(deployment.server_id, {
      id: commandId,
      action: 'docker:logs',
      appName: deployment.app_name,
      payload: {
        docker: { appId: deployment.app_name, lines },
      },
    }, deploymentId);

    if (result.status === 'error') {
      throw new Error(result.message || 'Failed to get logs');
    }

    return (result.data as { logs: string })?.logs || '';
  }

  /**
   * Get deployment by ID
   */
  getDeployment(deploymentId: string): DeploymentInfo | null {
    const row = this.getDeploymentRow(deploymentId);
    if (!row) return null;
    return this.rowToDeploymentInfo(row);
  }

  /**
   * Get all deployments for a server
   */
  getServerDeployments(serverId: string): DeploymentInfo[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM deployments WHERE server_id = ?
    `).all(serverId) as DeploymentRow[];
    return rows.map(row => this.rowToDeploymentInfo(row));
  }

  /**
   * Get all deployments
   */
  getAllDeployments(): DeploymentInfo[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM deployments').all() as DeploymentRow[];
    return rows.map(row => this.rowToDeploymentInfo(row));
  }

  /**
   * Transform Umbrel docker-compose.yml for OwnPrem deployment
   */
  private transformComposeFile(
    composeYaml: string,
    app: AppDefinition,
    secrets: Record<string, string>,
    serverId: string
  ): string {
    const compose = parseYaml(composeYaml) as ComposeFile;

    // Remove app_proxy service (we use Caddy)
    if (compose.services.app_proxy) {
      delete compose.services.app_proxy;
      logger.debug({ appId: app.id }, 'Removed app_proxy service');
    }

    // Update dependencies to remove app_proxy references
    for (const [serviceName, service] of Object.entries(compose.services)) {
      if (Array.isArray(service.depends_on)) {
        service.depends_on = service.depends_on.filter(dep => dep !== 'app_proxy');
      } else if (service.depends_on && typeof service.depends_on === 'object') {
        delete (service.depends_on as Record<string, unknown>).app_proxy;
      }

      // Add host network mode for single-server deployments
      // This allows containers to communicate via localhost
      service.network_mode = 'host';

      // Transform environment variables
      if (service.environment) {
        service.environment = this.transformEnvVars(
          service.environment,
          app,
          secrets,
          serverId
        );
      }

      // Update container names to avoid conflicts
      if (service.container_name) {
        service.container_name = `ownprem-${app.id}-${serviceName}`;
      }
    }

    // Remove networks (using host mode)
    delete compose.networks;

    // Transform volume paths
    if (compose.volumes) {
      // Keep named volumes but ensure they're prefixed
      const newVolumes: Record<string, unknown> = {};
      for (const [name, config] of Object.entries(compose.volumes)) {
        newVolumes[`ownprem-${app.id}-${name}`] = config;
      }
      compose.volumes = newVolumes;
    }

    return stringifyYaml(compose);
  }

  /**
   * Transform environment variables
   */
  private transformEnvVars(
    env: Record<string, string> | string[],
    app: AppDefinition,
    secrets: Record<string, string>,
    serverId: string
  ): Record<string, string> {
    const result: Record<string, string> = {};

    // Convert array format to object
    const envObj: Record<string, string> = {};
    if (Array.isArray(env)) {
      for (const item of env) {
        const [key, ...valueParts] = item.split('=');
        envObj[key] = valueParts.join('=');
      }
    } else {
      Object.assign(envObj, env);
    }

    // Variable replacements
    const replacements: Record<string, string> = {
      // Standard Umbrel variables
      'APP_BITCOIN_NODE_IP': '127.0.0.1',
      'APP_BITCOIN_RPC_PORT': String(app.port || 8332),
      'APP_BITCOIN_P2P_PORT': '8333',
      'APP_DATA_DIR': `/var/lib/ownprem/docker/${app.id}/data`,
      'TOR_DATA_DIR': `/var/lib/ownprem/docker/${app.id}/tor`,
      'TOR_PROXY_IP': '127.0.0.1',
      'TOR_PROXY_PORT': '9050',
      'APP_PASSWORD': secrets.APP_PASSWORD || this.generatePassword(),
      'APP_SEED': secrets.APP_SEED || this.generateSeed(),

      // Bitcoin-specific
      'APP_BITCOIN_RPC_USER': secrets.BITCOIN_RPC_USER || 'ownprem',
      'APP_BITCOIN_RPC_PASS': secrets.BITCOIN_RPC_PASS || this.generatePassword(),
      'APP_BITCOIN_RPC_AUTH': secrets.BITCOIN_RPC_AUTH || '',
    };

    // Process each environment variable
    for (const [key, value] of Object.entries(envObj)) {
      let processedValue = value;

      // Replace ${VAR} patterns
      processedValue = processedValue.replace(/\$\{([^}]+)\}/g, (_, varName) => {
        if (replacements[varName] !== undefined) {
          return replacements[varName];
        }
        // Keep unrecognized variables as-is for now
        logger.debug({ varName, appId: app.id }, 'Unknown environment variable');
        return `\${${varName}}`;
      });

      result[key] = processedValue;
    }

    return result;
  }

  /**
   * Generate secrets for a deployment
   */
  private async generateSecrets(
    deploymentId: string,
    app: AppDefinition
  ): Promise<Record<string, string>> {
    const secrets: Record<string, string> = {};

    // Generate Bitcoin-specific secrets for Bitcoin apps
    if (app.category === 'bitcoin') {
      secrets.BITCOIN_RPC_USER = 'ownprem';
      secrets.BITCOIN_RPC_PASS = this.generatePassword();

      // Generate RPC auth string (similar to rpcauth.py)
      const salt = this.generateHexString(16);
      const { createHmac } = require('crypto') as typeof import('crypto');
      const hmac = createHmac('sha256', salt);
      hmac.update(secrets.BITCOIN_RPC_PASS);
      const hash = hmac.digest('hex');
      secrets.BITCOIN_RPC_AUTH = `${secrets.BITCOIN_RPC_USER}:${salt}$${hash}`;
    }

    // Generic app secrets
    secrets.APP_PASSWORD = this.generatePassword();
    secrets.APP_SEED = this.generateSeed();

    // Store encrypted secrets using secretsManager
    await secretsManager.storeSecrets(deploymentId, secrets);

    return secrets;
  }

  /**
   * Generate a random password
   */
  private generatePassword(length: number = 32): string {
    return secretsManager.generatePassword(length);
  }

  /**
   * Generate a random hex string
   */
  private generateHexString(length: number): string {
    const { randomBytes } = require('crypto') as typeof import('crypto');
    return randomBytes(length).toString('hex');
  }

  /**
   * Generate a random seed (for wallet seeds, etc.)
   */
  private generateSeed(): string {
    return this.generateHexString(32);
  }

  /**
   * Update deployment status
   */
  private updateStatus(
    deploymentId: string,
    status: string,
    message: string | null
  ): void {
    const db = getDb();
    db.prepare(`
      UPDATE deployments
      SET status = ?, status_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, message, deploymentId);
  }

  /**
   * Get deployment row from database
   */
  private getDeploymentRow(deploymentId: string): DeploymentRow | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM deployments WHERE id = ?').get(deploymentId) as DeploymentRow | undefined;
  }

  /**
   * Convert database row to DeploymentInfo
   */
  private rowToDeploymentInfo(row: DeploymentRow): DeploymentInfo {
    return {
      id: row.id,
      serverId: row.server_id,
      appId: row.app_name,
      appName: row.app_name,
      version: row.version,
      status: row.status as DeploymentInfo['status'],
      statusMessage: row.status_message || undefined,
      installedAt: new Date(row.installed_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export const dockerDeployer = new DockerDeployer();
