import { io, Socket } from 'socket.io-client';
import type { AgentCommand, AgentStatusReport } from '@nodefoundry/shared';

export interface ConnectionOptions {
  serverId: string;
  foundryUrl: string;
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
    console.log(`Connecting to ${this.options.foundryUrl} as ${this.options.serverId}...`);

    this.socket = io(this.options.foundryUrl, {
      auth: {
        serverId: this.options.serverId,
        token: this.options.authToken,
      },
      reconnection: true,
      reconnectionDelay: 5000,
      reconnectionDelayMax: 30000,
      reconnectionAttempts: Infinity,
    });

    this.socket.on('connect', () => {
      console.log(`Connected to foundry as ${this.options.serverId}`);
      this.options.onConnect();
    });

    this.socket.on('disconnect', (reason) => {
      console.log(`Disconnected from foundry: ${reason}`);
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

  sendCommandResult(result: { commandId: string; status: 'success' | 'error'; message?: string; duration?: number }): void {
    if (!this.socket?.connected) {
      console.warn('Cannot send command result: not connected');
      return;
    }
    this.socket.emit('command:result', result);
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}
