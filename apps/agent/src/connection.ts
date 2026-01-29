import { io, Socket } from 'socket.io-client';
import type { AgentCommand, AgentStatusReport, LogResult, CommandAck } from '@ownprem/shared';

const RECONNECTION_DELAY_MS = 5000;
const RECONNECTION_DELAY_MAX_MS = 30000;

export interface ConnectionOptions {
  serverId: string;
  orchestratorUrl: string;
  authToken: string | null;
  onCommand: (command: AgentCommand) => Promise<void>;
  onConnect: () => void;
  onDisconnect: () => void;
}

export class Connection {
  private socket: Socket | null = null;
  private options: ConnectionOptions;

  constructor(options: ConnectionOptions) {
    this.options = options;
  }

  connect(): void {
    console.log(`Connecting to ${this.options.orchestratorUrl} as ${this.options.serverId}...`);

    this.socket = io(this.options.orchestratorUrl, {
      auth: {
        serverId: this.options.serverId,
        token: this.options.authToken,
      },
      reconnection: true,
      reconnectionDelay: RECONNECTION_DELAY_MS,
      reconnectionDelayMax: RECONNECTION_DELAY_MAX_MS,
      reconnectionAttempts: Infinity,
    });

    this.socket.on('connect', () => {
      console.log(`Connected to orchestrator as ${this.options.serverId}`);
      this.options.onConnect();
    });

    this.socket.on('disconnect', (reason) => {
      console.log(`Disconnected from orchestrator: ${reason}`);
      this.options.onDisconnect();
    });

    this.socket.on('connect_error', (err) => {
      console.error(`Connection error: ${err.message}`);
    });

    this.socket.on('command', async (command: AgentCommand) => {
      try {
        await this.options.onCommand(command);
      } catch (err) {
        console.error(`Error handling command ${command.id}:`, err);
      }
    });

    // Handle heartbeat ping/pong
    this.socket.on('ping', () => {
      this.socket?.emit('pong');
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  sendStatus(report: AgentStatusReport): void {
    if (!this.socket?.connected) {
      console.warn('Cannot send status: not connected');
      return;
    }
    this.socket.emit('status', report);
  }

  sendCommandAck(ack: CommandAck): void {
    if (!this.socket?.connected) {
      console.warn('Cannot send command ack: not connected');
      return;
    }
    this.socket.emit('command:ack', ack);
  }

  sendCommandResult(result: { commandId: string; status: 'success' | 'error'; message?: string; duration?: number }): void {
    if (!this.socket?.connected) {
      console.warn('Cannot send command result: not connected');
      return;
    }
    this.socket.emit('command:result', result);
  }

  sendLogResult(result: LogResult): void {
    if (!this.socket?.connected) {
      console.warn('Cannot send log result: not connected');
      return;
    }
    this.socket.emit('logs:result', result);
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}
