import { getDb } from '../db/index.js';
import { deployer } from './deployer.js';
import { isAgentConnected } from '../websocket/agentHandler.js';
import logger from '../lib/logger.js';
import type { AppManifest } from '@ownprem/shared';

const sysLogger = logger.child({ component: 'system-apps' });

interface AppRegistryRow {
  name: string;
  manifest: string;
  system: number;
  mandatory: number;
  singleton: number;
}

/**
 * System Apps Service
 *
 * Handles automatic installation of mandatory system apps on the core server.
 * This ensures CA and Caddy are always installed when the system starts.
 */
class SystemAppsService {
  private checkInterval: NodeJS.Timeout | null = null;
  private isInstalling = false;

  /**
   * Start monitoring for system app installation.
   * Waits for core agent to connect, then installs any missing mandatory apps.
   */
  start(): void {
    sysLogger.info('Starting system apps monitor');

    // Check immediately and then every 10 seconds until all mandatory apps are installed
    this.checkAndInstall().catch(err => {
      sysLogger.error({ err }, 'Error in initial system apps check');
    });
    this.checkInterval = setInterval(() => {
      this.checkAndInstall().catch(err => {
        sysLogger.error({ err }, 'Error in system apps check');
      });
    }, 10 * 1000);
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    sysLogger.info('Stopped system apps monitor');
  }

  /**
   * Check if mandatory system apps are installed and install any missing ones.
   */
  async checkAndInstall(): Promise<void> {
    // Don't run multiple checks simultaneously
    if (this.isInstalling) {
      return;
    }

    // Check if core agent is connected
    if (!isAgentConnected('core')) {
      sysLogger.debug('Core agent not connected, waiting...');
      return;
    }

    try {
      this.isInstalling = true;
      const missingApps = await this.getMissingMandatoryApps();

      if (missingApps.length === 0) {
        // All mandatory apps are installed, stop checking
        sysLogger.info('All mandatory system apps are installed');
        this.stop();
        return;
      }

      sysLogger.info({ apps: missingApps.map(a => a.name) }, 'Installing missing mandatory system apps');

      // Install apps in order (CA first, then Caddy)
      // Sort by name to ensure consistent order (ownprem-ca < ownprem-caddy)
      missingApps.sort((a, b) => a.name.localeCompare(b.name));

      for (const app of missingApps) {
        await this.installSystemApp(app);
      }
    } catch (err) {
      sysLogger.error({ err }, 'Error checking/installing system apps');
    } finally {
      this.isInstalling = false;
    }
  }

  /**
   * Get list of mandatory system apps that are not installed on the core server.
   */
  private async getMissingMandatoryApps(): Promise<AppManifest[]> {
    const db = getDb();

    // Get all mandatory system apps
    const mandatoryApps = db.prepare(`
      SELECT * FROM app_registry WHERE system = 1 AND mandatory = 1
    `).all() as AppRegistryRow[];

    // Get apps already deployed on core
    const deployedApps = db.prepare(`
      SELECT app_name FROM deployments WHERE server_id = 'core'
    `).all() as { app_name: string }[];

    const deployedSet = new Set(deployedApps.map(d => d.app_name));

    // Find missing apps
    const missing: AppManifest[] = [];
    for (const row of mandatoryApps) {
      if (!deployedSet.has(row.name)) {
        missing.push(JSON.parse(row.manifest) as AppManifest);
      }
    }

    return missing;
  }

  /**
   * Install a system app on the core server.
   */
  private async installSystemApp(manifest: AppManifest): Promise<void> {
    sysLogger.info({ app: manifest.name }, 'Installing mandatory system app');

    try {
      // Get default config values from the manifest
      const config: Record<string, unknown> = {};
      for (const field of manifest.configSchema) {
        if (field.default !== undefined) {
          config[field.name] = field.default;
        }
      }

      // Install on core server
      const deployment = await deployer.install('core', manifest.name, config);

      sysLogger.info({
        app: manifest.name,
        deploymentId: deployment.id
      }, 'Mandatory system app installed');

      // Start the app
      await deployer.start(deployment.id);

      sysLogger.info({ app: manifest.name }, 'Mandatory system app started');
    } catch (err) {
      sysLogger.error({ err, app: manifest.name }, 'Failed to install mandatory system app');
      throw err;
    }
  }

  /**
   * Check if a specific system app is installed on core.
   */
  async isSystemAppInstalled(appName: string): Promise<boolean> {
    const db = getDb();
    const row = db.prepare(`
      SELECT id FROM deployments WHERE server_id = 'core' AND app_name = ?
    `).get(appName);
    return !!row;
  }

  /**
   * Get status of all mandatory system apps.
   */
  async getSystemAppsStatus(): Promise<Array<{
    name: string;
    displayName: string;
    installed: boolean;
    status?: string;
  }>> {
    const db = getDb();

    // Get all mandatory system apps
    const mandatoryApps = db.prepare(`
      SELECT * FROM app_registry WHERE system = 1 AND mandatory = 1
    `).all() as AppRegistryRow[];

    // Get deployment status for each
    const result = [];
    for (const row of mandatoryApps) {
      const manifest = JSON.parse(row.manifest) as AppManifest;
      const deployment = db.prepare(`
        SELECT status FROM deployments WHERE server_id = 'core' AND app_name = ?
      `).get(row.name) as { status: string } | undefined;

      result.push({
        name: manifest.name,
        displayName: manifest.displayName,
        installed: !!deployment,
        status: deployment?.status,
      });
    }

    return result;
  }
}

export const systemAppsService = new SystemAppsService();
