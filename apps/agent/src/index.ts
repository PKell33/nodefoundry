import type { AgentCommand, AgentStatusReport } from '@ownprem/shared';
import { Connection } from './connection.js';
import { Executor } from './executor.js';
import { Reporter } from './reporter.js';

const STATUS_REPORT_INTERVAL = 10000; // 10 seconds

class Agent {
  private connection: Connection;
  private executor: Executor;
  private reporter: Reporter;
  private statusInterval: NodeJS.Timeout | null = null;

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
    });
  }

  async start(): Promise<void> {
    console.log(`Starting Ownprem Agent...`);
    console.log(`Server ID: ${this.serverId}`);
    console.log(`Orchestrator URL: ${this.orchestratorUrl}`);

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

  private async handleCommand(cmd: AgentCommand): Promise<void> {
    console.log(`[${cmd.id}] Received command: ${cmd.action} ${cmd.appName}`);

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

      console.log(`[${cmd.id}] Command completed successfully`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${cmd.id}] Command failed: ${message}`);

      this.connection.sendCommandResult({
        commandId: cmd.id,
        status: 'error',
        message,
        duration: Date.now() - start,
      });
    }

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
      console.error('Failed to report status:', err);
    }
  }
}

// Entry point
const serverId = process.env.SERVER_ID || 'core';
const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://localhost:3001';
const authToken = process.env.AUTH_TOKEN || null;

const agent = new Agent(serverId, orchestratorUrl, authToken);
agent.start().catch((err) => {
  console.error('Failed to start agent:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down agent...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down agent...');
  process.exit(0);
});
