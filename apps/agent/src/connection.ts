import { io, Socket } from 'socket.io-client';
import type { AgentCommand, AgentStatusReport, LogResult, CommandAck } from '@ownprem/shared';
import logger from './lib/logger.js';

const RECONNECTION_DELAY_MS = 5000;
const RECONNECTION_DELAY_MAX_MS = 30000;

export interface ConnectionOptions {
  serverId: string;
  orchestratorUrl: string;
  authToken: string | null;
  onCommand: (command: AgentCommand) => Promise<void>;
  onConnect: () => void;
  onDisconnect: () => void;
  onServerShutdown?: () => void;
}

export class Connection {
  private socket: Socket | null = null;
  private options: ConnectionOptions;

  constructor(options: ConnectionOptions) {
    this.options = options;
  }

  connect(): void {
    logger.info({ orchestratorUrl: this.options.orchestratorUrl, serverId: this.options.serverId }, 'Connecting to orchestrator');

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
      logger.info({ serverId: this.options.serverId }, 'Connected to orchestrator');
      this.options.onConnect();
    });

    this.socket.on('disconnect', (reason) => {
      logger.info({ reason }, 'Disconnected from orchestrator');
      this.options.onDisconnect();
    });

    this.socket.on('connect_error', (err) => {
      logger.error({ error: err.message }, 'Connection error');
    });

    this.socket.on('command', async (command: AgentCommand) => {
      try {
        await this.options.onCommand(command);
      } catch (err) {
        logger.error({ commandId: command.id, err }, 'Error handling command');
      }
    });

    // Handle heartbeat ping/pong
    this.socket.on('ping', () => {
      this.socket?.emit('pong');
    });

    // Handle server shutdown notification
    this.socket.on('server:shutdown', () => {
      logger.info('Received shutdown notification from orchestrator');
      if (this.options.onServerShutdown) {
        this.options.onServerShutdown();
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
      logger.warn('Cannot send status: not connected');
      return;
    }
    this.socket.emit('status', report);
  }

  sendCommandAck(ack: CommandAck): void {
    if (!this.socket?.connected) {
      logger.warn('Cannot send command ack: not connected');
      return;
    }
    this.socket.emit('command:ack', ack);
  }

  sendCommandResult(result: { commandId: string; status: 'success' | 'error'; message?: string; duration?: number }): void {
    if (!this.socket?.connected) {
      logger.warn('Cannot send command result: not connected');
      return;
    }
    this.socket.emit('command:result', result);
  }

  sendLogResult(result: LogResult): void {
    if (!this.socket?.connected) {
      logger.warn('Cannot send log result: not connected');
      return;
    }
    this.socket.emit('logs:result', result);
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}
