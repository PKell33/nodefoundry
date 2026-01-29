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
    private foundryUrl: string,
    private authToken: string | null
  ) {
    const appsDir = process.env.APPS_DIR || '/opt/ownprem/apps';
    this.executor = new Executor(appsDir);
    this.reporter = new Reporter(serverId);

    this.connection = new Connection({
      serverId,
      foundryUrl,
      authToken,
      onCommand: (cmd) => this.handleCommand(cmd),
      onConnect: () => this.onConnect(),
      onDisconnect: () => this.onDisconnect(),
    });
  }

  async start(): Promise<void> {
    console.log(`Starting Ownprem Agent...`);
    console.log(`Server ID: ${this.serverId}`);
    console.log(`Foundry URL: ${this.foundryUrl}`);

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
const serverId = process.env.SERVER_ID || 'foundry';
const foundryUrl = process.env.FOUNDRY_URL || 'http://localhost:3001';
const authToken = process.env.AUTH_TOKEN || null;

const agent = new Agent(serverId, foundryUrl, authToken);
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
