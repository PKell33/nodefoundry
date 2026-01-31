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

    // Stop all log streams
    this.executor.stopAllLogStreams();

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
        case 'mountStorage':
          if (!cmd.payload?.mountOptions) {
            throw new Error('Mount options required for mountStorage action');
          }
          await this.executor.mountStorage(cmd.payload.mountOptions);
          break;
        case 'unmountStorage':
          if (!cmd.payload?.mountOptions?.mountPoint) {
            throw new Error('Mount point required for unmountStorage action');
          }
          await this.executor.unmountStorage(cmd.payload.mountOptions.mountPoint);
          break;
        case 'checkMount': {
          if (!cmd.payload?.mountOptions?.mountPoint) {
            throw new Error('Mount point required for checkMount action');
          }
          const checkResult = await this.executor.checkMount(cmd.payload.mountOptions.mountPoint);
          this.connection.sendCommandResult({
            commandId: cmd.id,
            status: 'success',
            duration: Date.now() - start,
            data: checkResult,
          });
          return; // Don't send normal command result
        }
        case 'configureKeepalived': {
          if (!cmd.payload?.keepalivedConfig) {
            throw new Error('Keepalived config required for configureKeepalived action');
          }
          await this.executor.configureKeepalived(
            cmd.payload.keepalivedConfig,
            cmd.payload.enabled ?? true
          );
          break;
        }
        case 'checkKeepalived': {
          const keepalivedStatus = await this.executor.checkKeepalived();
          this.connection.sendCommandResult({
            commandId: cmd.id,
            status: 'success',
            duration: Date.now() - start,
            data: keepalivedStatus,
          });
          return; // Don't send normal command result
        }
        case 'streamLogs': {
          const streamStarted = this.executor.startLogStream(
            cmd.id, // Use command ID as stream ID
            cmd.appName,
            cmd.payload?.logOptions || {},
            (line) => this.connection.sendLogStreamLine(line),
            (error) => {
              this.connection.sendLogStreamStatus({
                streamId: cmd.id,
                appName: cmd.appName,
                status: 'error',
                message: error,
              });
            }
          );

          this.connection.sendLogStreamStatus({
            streamId: cmd.id,
            appName: cmd.appName,
            status: streamStarted ? 'started' : 'error',
            message: streamStarted ? undefined : 'Failed to start stream',
          });
          return; // Log streaming doesn't send normal command result
        }
        case 'stopStreamLogs': {
          const stopped = this.executor.stopLogStream(cmd.id);
          this.connection.sendLogStreamStatus({
            streamId: cmd.id,
            appName: cmd.appName,
            status: 'stopped',
            message: stopped ? undefined : 'Stream not found',
          });
          return;
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
        networkInfo: this.reporter.getNetworkInfo(),
        apps: await this.reporter.getAppStatuses(),
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
