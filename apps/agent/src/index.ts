import type { AgentCommand, AgentStatusReport } from '@ownprem/shared';
import { Connection } from './connection.js';
import { Executor } from './executor.js';
import { Reporter } from './reporter.js';
import logger from './lib/logger.js';

const STATUS_REPORT_INTERVAL = 10000; // 10 seconds

class Agent {
  private connection: Connection;
  private executor: Executor;
  private reporter: Reporter;
  private statusInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private activeCommandCount = 0;

  constructor(
    private serverId: string,
    private orchestratorUrl: string,
    private authToken: string | null
  ) {
    const appsDir = process.env.APPS_DIR || '/opt/ownprem/apps';
    const dataDir = process.env.DATA_DIR || undefined; // Let Executor determine default
    this.executor = new Executor(appsDir, dataDir);
    this.reporter = new Reporter(serverId);

    this.connection = new Connection({
      serverId,
      orchestratorUrl,
      authToken,
      onCommand: (cmd) => this.handleCommand(cmd),
      onConnect: () => this.onConnect(),
      onDisconnect: () => this.onDisconnect(),
      onServerShutdown: () => this.onServerShutdown(),
    });
  }

  async start(): Promise<void> {
    logger.info({ serverId: this.serverId, orchestratorUrl: this.orchestratorUrl }, 'Starting Ownprem Agent');

    this.connection.connect();
  }

  private onConnect(): void {
    // Send initial status
    this.reportStatus();

    // Start periodic status reporting
    this.statusInterval = setInterval(() => {
      this.reportStatus();
    }, STATUS_REPORT_INTERVAL);
  }

  private onDisconnect(): void {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
  }

  private onServerShutdown(): void {
    logger.info('Orchestrator is shutting down, initiating graceful shutdown');
    this.shutdown();
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;
    logger.info('Starting graceful shutdown');

    // Stop accepting new commands by clearing status interval
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    // Wait for active commands to complete (max 30 seconds)
    const startTime = Date.now();
    const maxWaitMs = 30000;
    while (this.activeCommandCount > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= maxWaitMs) {
        logger.warn({ activeCommands: this.activeCommandCount }, 'Shutdown timeout - commands still in progress');
        break;
      }
      logger.debug({ activeCommands: this.activeCommandCount }, 'Waiting for active commands to complete');
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Disconnect cleanly
    this.connection.disconnect();
    logger.info('Graceful shutdown complete');
    process.exit(0);
  }

  private async handleCommand(cmd: AgentCommand): Promise<void> {
    // Reject new commands during shutdown
    if (this.isShuttingDown) {
      logger.warn({ commandId: cmd.id, action: cmd.action, appName: cmd.appName }, 'Rejecting command during shutdown');
      this.connection.sendCommandResult({
        commandId: cmd.id,
        status: 'error',
        message: 'Agent is shutting down',
      });
      return;
    }

    logger.info({ commandId: cmd.id, action: cmd.action, appName: cmd.appName }, 'Received command');
    this.activeCommandCount++;

    // Send acknowledgment immediately
    this.connection.sendCommandAck({
      commandId: cmd.id,
      receivedAt: new Date(),
    });

    const start = Date.now();

    try {
      switch (cmd.action) {
        case 'install':
          await this.executor.install(cmd.appName, cmd.payload || {});
          break;
        case 'configure':
          await this.executor.configure(cmd.appName, cmd.payload?.files || []);
          break;
        case 'start':
          await this.executor.systemctl('start', cmd.appName);
          break;
        case 'stop':
          await this.executor.systemctl('stop', cmd.appName);
          break;
        case 'restart':
          await this.executor.systemctl('restart', cmd.appName);
          break;
        case 'uninstall':
          await this.executor.uninstall(cmd.appName);
          break;
        case 'getLogs': {
          const logResult = await this.executor.getLogs(cmd.appName, cmd.payload?.logOptions);
          this.connection.sendLogResult({
            commandId: cmd.id,
            ...logResult,
          });
          return; // Don't send normal command result for logs
        }
        default:
          throw new Error(`Unknown action: ${cmd.action}`);
      }

      this.connection.sendCommandResult({
        commandId: cmd.id,
        status: 'success',
        duration: Date.now() - start,
      });

      logger.info({ commandId: cmd.id, action: cmd.action, duration: Date.now() - start }, 'Command completed successfully');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ commandId: cmd.id, action: cmd.action, error: message }, 'Command failed');

      this.connection.sendCommandResult({
        commandId: cmd.id,
        status: 'error',
        message,
        duration: Date.now() - start,
      });
    }

    // Decrement active command count
    this.activeCommandCount--;

    // Report status after command completion
    await this.reportStatus();
  }

  private async reportStatus(): Promise<void> {
    try {
      const report: AgentStatusReport = {
        serverId: this.serverId,
        timestamp: new Date(),
        metrics: await this.reporter.getMetrics(),
        apps: await this.reporter.getAppStatuses(),
      };

      this.connection.sendStatus(report);
    } catch (err) {
      logger.error({ err }, 'Failed to report status');
    }
  }
}

// Entry point
const serverId = process.env.SERVER_ID || 'core';
const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://localhost:3001';
const authToken = process.env.AUTH_TOKEN || null;

const agent = new Agent(serverId, orchestratorUrl, authToken);
agent.start().catch((err) => {
  logger.fatal({ err }, 'Failed to start agent');
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT');
  agent.shutdown();
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM');
  agent.shutdown();
});
