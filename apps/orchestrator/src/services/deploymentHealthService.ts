import { getDb } from '../db/index.js';
import logger from '../lib/logger.js';

const healthLogger = logger.child({ service: 'deployment-health' });

// How long a deployment can stay in transient states before being marked as error
const TRANSIENT_STATE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// How often to check for stuck deployments
const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

interface StuckDeployment {
  id: string;
  app_name: string;
  server_id: string;
  status: string;
  updated_at: string;
}

/**
 * Service to monitor deployment health and recover stuck deployments.
 * Periodically checks for deployments stuck in transient states
 * (installing, configuring, uninstalling) and marks them as error.
 */
class DeploymentHealthService {
  private checkInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * Start the health check interval.
   */
  start(): void {
    if (this.isRunning) {
      healthLogger.warn('Deployment health service already running');
      return;
    }

    this.isRunning = true;
    healthLogger.info({ intervalMs: CHECK_INTERVAL_MS, timeoutMs: TRANSIENT_STATE_TIMEOUT_MS },
      'Starting deployment health service');

    // Run initial check
    this.checkStuckDeployments().catch(err => {
      healthLogger.error({ err }, 'Error in initial stuck deployment check');
    });

    // Schedule periodic checks
    this.checkInterval = setInterval(() => {
      this.checkStuckDeployments().catch(err => {
        healthLogger.error({ err }, 'Error checking stuck deployments');
      });
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Stop the health check interval.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isRunning = false;
    healthLogger.info('Deployment health service stopped');
  }

  /**
   * Check for and recover stuck deployments.
   */
  async checkStuckDeployments(): Promise<number> {
    const db = getDb();
    const cutoffTime = new Date(Date.now() - TRANSIENT_STATE_TIMEOUT_MS).toISOString();

    // Find deployments stuck in transient states
    const stuckDeployments = db.prepare(`
      SELECT id, app_name, server_id, status, updated_at
      FROM deployments
      WHERE status IN ('installing', 'configuring', 'uninstalling')
        AND updated_at < ?
    `).all(cutoffTime) as StuckDeployment[];

    if (stuckDeployments.length === 0) {
      return 0;
    }

    healthLogger.warn({ count: stuckDeployments.length },
      'Found deployments stuck in transient states');

    // Mark each stuck deployment as error
    const updateStmt = db.prepare(`
      UPDATE deployments
      SET status = 'error',
          status_message = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    for (const deployment of stuckDeployments) {
      const stuckDuration = Date.now() - new Date(deployment.updated_at).getTime();
      const stuckMinutes = Math.floor(stuckDuration / 60000);

      const message = `Deployment stuck in '${deployment.status}' state for ${stuckMinutes} minutes. ` +
        'The operation may have failed or the agent may have disconnected. ' +
        'Check agent logs for details.';

      updateStmt.run(message, deployment.id);

      healthLogger.warn({
        deploymentId: deployment.id,
        appName: deployment.app_name,
        serverId: deployment.server_id,
        previousStatus: deployment.status,
        stuckMinutes,
      }, 'Recovered stuck deployment');

      // Also mark any pending commands for this deployment as timed out
      db.prepare(`
        UPDATE command_log
        SET status = 'timeout',
            result_message = 'Deployment health check marked command as timed out',
            completed_at = CURRENT_TIMESTAMP
        WHERE deployment_id = ? AND status = 'pending'
      `).run(deployment.id);
    }

    return stuckDeployments.length;
  }

  /**
   * Get the current state of the health service.
   */
  getStatus(): { running: boolean; lastCheck?: Date } {
    return {
      running: this.isRunning,
    };
  }
}

export const deploymentHealthService = new DeploymentHealthService();
