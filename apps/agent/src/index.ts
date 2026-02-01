import type { AgentCommand, AgentStatusReport } from '@ownprem/shared';
import { Connection } from './connection.js';
import { Reporter } from './reporter.js';
import { privilegedClient } from './privilegedClient.js';
import logger from './lib/logger.js';

const STATUS_REPORT_INTERVAL = 10000; // 10 seconds

class Agent {
  private connection: Connection;
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
    this.reporter = new Reporter(serverId, appsDir);

    this.connection = new Connection({
      serverId,
      orchestratorUrl,
      authToken,
      onCommand: (cmd) => this.handleCommand(cmd),
      onConnect: () => this.onConnect(),
      onDisconnect: () => this.onDisconnect(),
      onServerShutdown: () => this.onServerShutdown(),
      onStatusRequest: () => this.reportStatus(),
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
    this.shutdown().catch((err) => {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    });
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
      logger.warn({ commandId: cmd.id, action: cmd.action }, 'Rejecting command during shutdown');
      this.connection.sendCommandResult({
        commandId: cmd.id,
        status: 'error',
        message: 'Agent is shutting down',
      });
      return;
    }

    logger.info({ commandId: cmd.id, action: cmd.action }, 'Received command');
    this.activeCommandCount++;

    // Send acknowledgment immediately
    this.connection.sendCommandAck({
      commandId: cmd.id,
      receivedAt: new Date(),
    });

    const start = Date.now();

    try {
      switch (cmd.action) {
        case 'mountStorage':
          if (!cmd.payload?.mountOptions) {
            throw new Error('Mount options required for mountStorage action');
          }
          await this.mountStorage(cmd.payload.mountOptions);
          break;
        case 'unmountStorage':
          if (!cmd.payload?.mountOptions?.mountPoint) {
            throw new Error('Mount point required for unmountStorage action');
          }
          await this.unmountStorage(cmd.payload.mountOptions.mountPoint);
          break;
        case 'checkMount': {
          if (!cmd.payload?.mountOptions?.mountPoint) {
            throw new Error('Mount point required for checkMount action');
          }
          const checkResult = await this.checkMount(cmd.payload.mountOptions.mountPoint);
          this.connection.sendCommandResult({
            commandId: cmd.id,
            status: 'success',
            duration: Date.now() - start,
            data: checkResult,
          });
          this.activeCommandCount--;
          return; // Don't send normal command result
        }
        // TODO: Add Docker commands here
        // case 'docker:deploy':
        // case 'docker:start':
        // case 'docker:stop':
        // case 'docker:logs':
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

  // Mount storage via privileged helper
  private async mountStorage(options: {
    mountType: string;
    source: string;
    mountPoint: string;
    options?: string;
    credentials?: { username: string; password: string; domain?: string };
  }): Promise<void> {
    logger.info({ mountPoint: options.mountPoint, source: options.source }, 'Mounting storage');

    await privilegedClient.mount(
      options.mountType as 'nfs' | 'cifs',
      options.source,
      options.mountPoint,
      options.options,
      options.credentials
    );
  }

  // Unmount storage via privileged helper
  private async unmountStorage(mountPoint: string): Promise<void> {
    logger.info({ mountPoint }, 'Unmounting storage');
    await privilegedClient.umount(mountPoint);
  }

  // Check if mount point is mounted
  private async checkMount(mountPoint: string): Promise<{ mounted: boolean; source?: string }> {
    const { execSync } = await import('child_process');
    try {
      const output = execSync(`findmnt -n -o SOURCE "${mountPoint}"`, { encoding: 'utf8' });
      return { mounted: true, source: output.trim() };
    } catch {
      return { mounted: false };
    }
  }

  private async reportStatus(): Promise<void> {
    try {
      const report: AgentStatusReport = {
        serverId: this.serverId,
        timestamp: new Date(),
        metrics: await this.reporter.getMetrics(),
        networkInfo: this.reporter.getNetworkInfo(),
        apps: [], // No native apps anymore - Docker containers will be reported differently
      };

      this.connection.sendStatus(report);
    } catch (err) {
      logger.error({ err }, 'Failed to report status');
    }
  }
}

// Environment validation
function validateEnvConfig(): void {
  const isDev = process.env.NODE_ENV !== 'production';
  const errors: string[] = [];

  // Validate ORCHESTRATOR_URL
  const orchestratorUrl = process.env.ORCHESTRATOR_URL;
  if (orchestratorUrl) {
    try {
      new URL(orchestratorUrl);
    } catch {
      errors.push(`ORCHESTRATOR_URL is not a valid URL: ${orchestratorUrl}`);
    }
  }

  // In production, AUTH_TOKEN is required for secure agent-orchestrator communication
  // Exception: core server connecting via localhost doesn't need a token
  const isCore = process.env.SERVER_ID === 'core';
  const isLocalhost = orchestratorUrl && (orchestratorUrl.includes('localhost') || orchestratorUrl.includes('127.0.0.1'));
  if (!isDev && !process.env.AUTH_TOKEN && !(isCore && isLocalhost)) {
    errors.push('AUTH_TOKEN is required in production for secure agent authentication');
  }

  if (errors.length > 0) {
    logger.fatal({ errors }, 'Invalid environment configuration');
    process.exit(1);
  }
}

// Entry point
validateEnvConfig();

const serverId = process.env.SERVER_ID || 'core';
const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://localhost:3001';
const authToken = process.env.AUTH_TOKEN || null;

const agent = new Agent(serverId, orchestratorUrl, authToken);
agent.start().catch((err) => {
  logger.fatal({ err }, 'Failed to start agent');
  process.exit(1);
});

// Graceful shutdown
// Use an async handler wrapper to properly await shutdown and catch errors
const handleShutdownSignal = (signal: string) => {
  logger.info(`Received ${signal}`);
  agent.shutdown().catch((err) => {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  });
};

process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
