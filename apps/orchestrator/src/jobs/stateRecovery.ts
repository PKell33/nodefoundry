import { getDb } from '../db/index.js';
import { isAgentConnected, sendCommand } from '../websocket/agentHandler.js';
import { mutexManager } from '../lib/mutexManager.js';
import { updateDeploymentStatus } from '../lib/deploymentHelpers.js';
import { auditService } from '../services/auditService.js';
import logger from '../lib/logger.js';
import { v4 as uuidv4 } from 'uuid';

export interface RecoveryResult {
  deploymentId: string;
  appName: string;
  serverId: string;
  previousState: string;
  action: 'marked_error' | 'status_synced' | 'no_action';
  newState?: string;
  message: string;
}

export interface RecoveryStatus {
  stuckDeployments: {
    id: string;
    appName: string;
    serverId: string;
    status: string;
    serverOnline: boolean;
    updatedAt: string;
  }[];
  lastRecoveryRun: Date | null;
  recoveryResults: RecoveryResult[];
}

interface DeploymentRow {
  id: string;
  app_name: string;
  server_id: string;
  status: string;
  updated_at: string;
}

interface ServerStatusRow {
  agent_status: string;
}

// Transient states that indicate an operation was in progress
const TRANSIENT_STATES = ['installing', 'configuring', 'uninstalling'];

interface PendingCommandRow {
  id: string;
  server_id: string;
  deployment_id: string | null;
  action: string;
  created_at: string;
}

// Track the last recovery run
let lastRecoveryRun: Date | null = null;
let lastRecoveryResults: RecoveryResult[] = [];

/**
 * StateRecoveryService handles recovery of deployments stuck in transient states
 * after an orchestrator crash or restart.
 */
class StateRecoveryService {
  /**
   * Check if a deployment status is transient (in-progress operation).
   */
  isTransientState(status: string): boolean {
    return TRANSIENT_STATES.includes(status);
  }

  /**
   * Get all deployments in transient states.
   */
  getStuckDeployments(): DeploymentRow[] {
    const db = getDb();
    const placeholders = TRANSIENT_STATES.map(() => '?').join(',');
    return db.prepare(`
      SELECT id, app_name, server_id, status, updated_at
      FROM deployments
      WHERE status IN (${placeholders})
    `).all(...TRANSIENT_STATES) as DeploymentRow[];
  }

  /**
   * Query an agent for the actual status of an app.
   * Sends a status-query command and waits for result.
   */
  async queryAppStatus(serverId: string, appName: string): Promise<{ installed: boolean; running: boolean } | null> {
    if (!isAgentConnected(serverId)) {
      return null;
    }

    try {
      const commandId = uuidv4();

      // Note: This relies on the agent supporting a 'status-query' action.
      // If not implemented, we fall back to marking as error.
      const sent = sendCommand(serverId, {
        id: commandId,
        action: 'status-query',
        appName,
        payload: {},
      });

      if (!sent) {
        return null;
      }

      // The command result will be handled by the normal command flow.
      // For now, we can't easily wait for the result, so we return null
      // and rely on the conservative approach of marking stuck deployments as error.
      // In a future enhancement, we could add a promise-based sendCommandWithResult().
      return null;
    } catch (error) {
      logger.warn({ serverId, appName, error }, 'Failed to query app status');
      return null;
    }
  }

  /**
   * Attempt to sync the actual state of a deployment from its agent.
   */
  async syncDeploymentState(deploymentId: string): Promise<RecoveryResult> {
    const db = getDb();
    const deployment = db.prepare(`
      SELECT id, app_name, server_id, status, updated_at
      FROM deployments WHERE id = ?
    `).get(deploymentId) as DeploymentRow | undefined;

    if (!deployment) {
      return {
        deploymentId,
        appName: 'unknown',
        serverId: 'unknown',
        previousState: 'unknown',
        action: 'no_action',
        message: 'Deployment not found',
      };
    }

    if (!this.isTransientState(deployment.status)) {
      return {
        deploymentId,
        appName: deployment.app_name,
        serverId: deployment.server_id,
        previousState: deployment.status,
        action: 'no_action',
        message: 'Deployment is not in a transient state',
      };
    }

    return await mutexManager.withDeploymentLock(deploymentId, async () => {
      const serverStatus = db.prepare('SELECT agent_status FROM servers WHERE id = ?')
        .get(deployment.server_id) as ServerStatusRow | undefined;

      const serverOnline = serverStatus?.agent_status === 'online';

      if (!serverOnline) {
        // Server is offline - mark deployment as error
        updateDeploymentStatus(
          deploymentId,
          'error',
          `Recovery: Server offline, previous state was '${deployment.status}'`
        );

        return {
          deploymentId,
          appName: deployment.app_name,
          serverId: deployment.server_id,
          previousState: deployment.status,
          action: 'marked_error',
          newState: 'error',
          message: 'Server offline - marked as error',
        };
      }

      // Server is online - try to query actual status
      const actualStatus = await this.queryAppStatus(deployment.server_id, deployment.app_name);

      if (actualStatus) {
        // We got a status - update accordingly
        let newStatus: string;
        let message: string;

        if (actualStatus.running) {
          newStatus = 'running';
          message = 'Recovery: App found running';
        } else if (actualStatus.installed) {
          newStatus = 'stopped';
          message = 'Recovery: App installed but not running';
        } else {
          newStatus = 'error';
          message = `Recovery: App not found after incomplete '${deployment.status}' operation`;
        }

        updateDeploymentStatus(deploymentId, newStatus as any, message);

        return {
          deploymentId,
          appName: deployment.app_name,
          serverId: deployment.server_id,
          previousState: deployment.status,
          action: 'status_synced',
          newState: newStatus,
          message,
        };
      }

      // Couldn't query status - use conservative approach based on previous state
      let newStatus: string;
      let statusMessage: string;

      switch (deployment.status) {
        case 'installing':
          // Installation was incomplete - mark as error
          newStatus = 'error';
          statusMessage = 'Recovery: Installation was interrupted';
          break;
        case 'configuring':
          // Configuration was incomplete - mark as stopped (likely partially configured)
          newStatus = 'stopped';
          statusMessage = 'Recovery: Configuration was interrupted - may need reconfiguration';
          break;
        case 'uninstalling':
          // Uninstall was incomplete - mark as error (state is unknown)
          newStatus = 'error';
          statusMessage = 'Recovery: Uninstallation was interrupted - manual cleanup may be required';
          break;
        default:
          newStatus = 'error';
          statusMessage = `Recovery: Unknown transient state '${deployment.status}'`;
      }

      updateDeploymentStatus(deploymentId, newStatus as any, statusMessage);

      return {
        deploymentId,
        appName: deployment.app_name,
        serverId: deployment.server_id,
        previousState: deployment.status,
        action: 'marked_error',
        newState: newStatus,
        message: statusMessage,
      };
    });
  }

  /**
   * Run recovery for all stuck deployments.
   * Called on startup and can be triggered manually.
   */
  async recoverStuckDeployments(): Promise<RecoveryResult[]> {
    const stuckDeployments = this.getStuckDeployments();

    if (stuckDeployments.length === 0) {
      logger.info('No stuck deployments found during recovery check');
      lastRecoveryRun = new Date();
      lastRecoveryResults = [];
      return [];
    }

    logger.info({ count: stuckDeployments.length }, 'Found stuck deployments - starting recovery');

    const results: RecoveryResult[] = [];

    for (const deployment of stuckDeployments) {
      try {
        const result = await this.syncDeploymentState(deployment.id);
        results.push(result);
        logger.info({
          deploymentId: deployment.id,
          appName: deployment.app_name,
          previousState: deployment.status,
          action: result.action,
          newState: result.newState,
        }, 'Deployment recovery processed');
      } catch (error) {
        logger.error({ deploymentId: deployment.id, error }, 'Failed to recover deployment');
        results.push({
          deploymentId: deployment.id,
          appName: deployment.app_name,
          serverId: deployment.server_id,
          previousState: deployment.status,
          action: 'marked_error',
          message: `Recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // Log audit event
    auditService.log({
      action: 'state_recovery',
      resourceType: 'system',
      details: {
        processedCount: results.length,
        markedError: results.filter(r => r.action === 'marked_error').length,
        statusSynced: results.filter(r => r.action === 'status_synced').length,
      },
    });

    lastRecoveryRun = new Date();
    lastRecoveryResults = results;

    return results;
  }

  /**
   * Recover commands stuck in 'pending' status.
   * These are commands that were sent but never received a result (e.g., orchestrator crashed).
   * Mark them as 'error' so the system doesn't wait for them indefinitely.
   */
  async recoverPendingCommands(): Promise<number> {
    const db = getDb();

    // Find commands that are still pending (no result received)
    const pendingCommands = db.prepare(`
      SELECT id, server_id, deployment_id, action, created_at
      FROM command_log
      WHERE status = 'pending'
    `).all() as PendingCommandRow[];

    if (pendingCommands.length === 0) {
      logger.info('No pending commands found during recovery');
      return 0;
    }

    logger.info({ count: pendingCommands.length }, 'Found pending commands - marking as error');

    // Mark all pending commands as error
    const result = db.prepare(`
      UPDATE command_log
      SET status = 'error',
          result_message = 'Recovery: Command was pending when orchestrator restarted',
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'pending'
    `).run();

    // Log details about recovered commands
    for (const cmd of pendingCommands) {
      logger.info({
        commandId: cmd.id,
        serverId: cmd.server_id,
        deploymentId: cmd.deployment_id,
        action: cmd.action,
        createdAt: cmd.created_at,
      }, 'Marked pending command as error');
    }

    auditService.log({
      action: 'pending_commands_recovery',
      resourceType: 'system',
      details: {
        recoveredCount: result.changes,
        commands: pendingCommands.map(c => ({
          id: c.id,
          action: c.action,
          serverId: c.server_id,
        })),
      },
    });

    return result.changes;
  }

  /**
   * Get current recovery status and stuck deployments.
   */
  getRecoveryStatus(): RecoveryStatus {
    const stuckDeployments = this.getStuckDeployments();
    const db = getDb();

    const deploymentsWithServerStatus = stuckDeployments.map(d => {
      const serverStatus = db.prepare('SELECT agent_status FROM servers WHERE id = ?')
        .get(d.server_id) as ServerStatusRow | undefined;

      return {
        id: d.id,
        appName: d.app_name,
        serverId: d.server_id,
        status: d.status,
        serverOnline: serverStatus?.agent_status === 'online',
        updatedAt: d.updated_at,
      };
    });

    return {
      stuckDeployments: deploymentsWithServerStatus,
      lastRecoveryRun,
      recoveryResults: lastRecoveryResults,
    };
  }
}

export const stateRecoveryService = new StateRecoveryService();

/**
 * Run state recovery on startup.
 * This should be called after the database is initialized.
 */
export async function runStartupRecovery(): Promise<void> {
  try {
    logger.info('Running startup state recovery');

    // Recover pending commands first (cleans up command_log)
    const pendingCommandsRecovered = await stateRecoveryService.recoverPendingCommands();
    logger.info({ pendingCommandsRecovered }, 'Pending command recovery complete');

    // Then recover stuck deployments
    await stateRecoveryService.recoverStuckDeployments();
    logger.info('Deployment state recovery complete');
  } catch (error) {
    logger.error({ error }, 'Failed to run startup state recovery');
    // Don't throw - we don't want to prevent startup
  }
}
