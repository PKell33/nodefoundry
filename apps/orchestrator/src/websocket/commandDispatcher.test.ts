/**
 * Command Dispatcher Tests
 *
 * Tests for the command timeout and result handling system.
 * Covers:
 * - Ack timeout updates command_log to "timeout"
 * - Completion timeout updates deployment to "error"
 * - Late results after timeout are ignored
 * - Pending promises are rejected on timeout
 * - Multiple timeouts don't corrupt shared state
 * - Agent disconnect cleanup
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Server as SocketServer, Socket } from 'socket.io';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Create test database
let db: Database.Database;

// Mock socket
const createMockSocket = (): Socket => ({
  emit: vi.fn(),
  on: vi.fn(),
  id: 'mock-socket-id',
} as unknown as Socket);

// Mock Socket.IO server
const createMockIo = (): SocketServer => ({
  to: vi.fn().mockReturnThis(),
  emit: vi.fn(),
} as unknown as SocketServer);

// Mock modules before importing
vi.mock('../db/index.js', () => ({
  getDb: () => db,
}));

vi.mock('../lib/mutexManager.js', () => ({
  mutexManager: {
    withDeploymentLock: async (id: string, fn: () => Promise<void>) => fn(),
  },
}));

vi.mock('../lib/deploymentHelpers.js', () => ({
  updateDeploymentStatus: vi.fn(),
}));

vi.mock('../services/proxyManager.js', () => ({
  proxyManager: {},
}));

vi.mock('./index.js', () => ({
  broadcastDeploymentStatus: vi.fn(),
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

vi.mock('../lib/logger.js', () => ({
  wsLogger: mockLogger,
}));

// Import after mocks
const {
  sendCommand,
  sendCommandWithResult,
  handleCommandAck,
  handleCommandResult,
  cleanupPendingCommandsForServer,
  getPendingCommandCount,
  abortPendingCommands,
  hasPendingCommands,
  ACK_TIMEOUT,
  COMPLETION_TIMEOUTS,
} = await import('./commandDispatcher.js');

const { updateDeploymentStatus } = await import('../lib/deploymentHelpers.js');

describe('Command Dispatcher', () => {
  beforeAll(() => {
    // Create in-memory database with schema
    db = new Database(':memory:');
    const schemaPath = join(__dirname, '../db/schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    db.exec(schema);
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    // Use fake timers
    vi.useFakeTimers();

    // Clear relevant tables
    db.exec('DELETE FROM command_log');
    db.exec('DELETE FROM deployments');
    db.exec('DELETE FROM servers');
    db.exec('DELETE FROM app_registry');

    // Set up test data
    db.prepare(`
      INSERT INTO servers (id, name, is_core, agent_status)
      VALUES ('test-server', 'Test Server', 0, 'online')
    `).run();

    db.prepare(`
      INSERT INTO app_registry (name, manifest)
      VALUES ('test-app', '{}')
    `).run();

    db.prepare(`
      INSERT INTO deployments (id, server_id, app_name, version, config, status)
      VALUES ('deploy-1', 'test-server', 'test-app', '1.0.0', '{}', 'installing')
    `).run();

    vi.clearAllMocks();

    // Clean up any pending commands from previous tests
    abortPendingCommands();
  });

  afterEach(() => {
    vi.useRealTimers();
    abortPendingCommands();
  });

  describe('ACK Timeout', () => {
    it('should update command_log to timeout after ACK_TIMEOUT', () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;

      const commandId = 'cmd-ack-timeout-1';
      sendCommand(
        'test-server',
        { id: commandId, action: 'install', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      // Verify command is pending
      const beforeTimeout = db.prepare('SELECT status FROM command_log WHERE id = ?').get(commandId) as { status: string };
      expect(beforeTimeout.status).toBe('pending');

      // Advance time past ACK timeout
      vi.advanceTimersByTime(ACK_TIMEOUT + 100);

      // Verify command status is now timeout
      const afterTimeout = db.prepare('SELECT status, result_message FROM command_log WHERE id = ?').get(commandId) as { status: string; result_message: string };
      expect(afterTimeout.status).toBe('timeout');
      expect(afterTimeout.result_message).toContain('acknowledge');
    });

    it('should update deployment to error on ACK timeout', () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;

      sendCommand(
        'test-server',
        { id: 'cmd-ack-deploy-1', action: 'install', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      vi.advanceTimersByTime(ACK_TIMEOUT + 100);

      expect(updateDeploymentStatus).toHaveBeenCalledWith(
        'deploy-1',
        'error',
        expect.stringContaining('acknowledge')
      );
    });

    it('should reject pending promise on ACK timeout', async () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;

      const promise = sendCommandWithResult(
        'test-server',
        { id: 'cmd-ack-reject-1', action: 'install', appName: 'test-app' },
        getAgentSocket,
        'deploy-1'
      );

      // Advance time past ACK timeout
      vi.advanceTimersByTime(ACK_TIMEOUT + 100);

      await expect(promise).rejects.toThrow('acknowledge');
    });

    it('should not timeout if ACK received before timeout', () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-ack-ok-1';

      sendCommand(
        'test-server',
        { id: commandId, action: 'install', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      // Simulate ACK before timeout
      vi.advanceTimersByTime(ACK_TIMEOUT / 2);
      handleCommandAck('test-server', { commandId, receivedAt: new Date() });

      // Advance past original timeout
      vi.advanceTimersByTime(ACK_TIMEOUT);

      // Should still be pending (not timed out)
      const status = db.prepare('SELECT status FROM command_log WHERE id = ?').get(commandId) as { status: string };
      expect(status.status).toBe('pending');
    });
  });

  describe('Completion Timeout', () => {
    it('should update command_log to timeout after completion timeout', () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-completion-timeout-1';

      sendCommand(
        'test-server',
        { id: commandId, action: 'start', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      // Acknowledge the command
      handleCommandAck('test-server', { commandId, receivedAt: new Date() });

      // Advance past completion timeout for 'start' action
      const startTimeout = COMPLETION_TIMEOUTS['start'];
      vi.advanceTimersByTime(startTimeout + 100);

      const afterTimeout = db.prepare('SELECT status, result_message FROM command_log WHERE id = ?').get(commandId) as { status: string; result_message: string };
      expect(afterTimeout.status).toBe('timeout');
      expect(afterTimeout.result_message).toContain('timed out');
    });

    it('should update deployment to error on completion timeout', () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-completion-deploy-1';

      sendCommand(
        'test-server',
        { id: commandId, action: 'start', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      handleCommandAck('test-server', { commandId, receivedAt: new Date() });

      vi.advanceTimersByTime(COMPLETION_TIMEOUTS['start'] + 100);

      expect(updateDeploymentStatus).toHaveBeenCalledWith(
        'deploy-1',
        'error',
        expect.stringContaining('timed out')
      );
    });

    it('should reject pending promise on completion timeout', async () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-completion-reject-1';

      const promise = sendCommandWithResult(
        'test-server',
        { id: commandId, action: 'start', appName: 'test-app' },
        getAgentSocket,
        'deploy-1'
      );

      handleCommandAck('test-server', { commandId, receivedAt: new Date() });

      vi.advanceTimersByTime(COMPLETION_TIMEOUTS['start'] + 100);

      await expect(promise).rejects.toThrow('timed out');
    });

    it('should use different timeouts for different actions', () => {
      expect(COMPLETION_TIMEOUTS['install']).toBe(10 * 60 * 1000); // 10 minutes
      expect(COMPLETION_TIMEOUTS['start']).toBe(30 * 1000);        // 30 seconds
      expect(COMPLETION_TIMEOUTS['configure']).toBe(60 * 1000);    // 1 minute
    });
  });

  describe('Late Results After Timeout', () => {
    it('should ignore late result after ACK timeout', async () => {
      const mockSocket = createMockSocket();
      const mockIo = createMockIo();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-late-ack-1';

      sendCommand(
        'test-server',
        { id: commandId, action: 'install', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      // Let ACK timeout occur
      vi.advanceTimersByTime(ACK_TIMEOUT + 100);

      // Verify timeout was recorded
      const beforeLate = db.prepare('SELECT status FROM command_log WHERE id = ?').get(commandId) as { status: string };
      expect(beforeLate.status).toBe('timeout');

      // Now a late result arrives
      await handleCommandResult(mockIo, 'test-server', {
        commandId,
        status: 'success',
        message: 'Late success',
      });

      // Status should still be timeout, not overwritten
      const afterLate = db.prepare('SELECT status FROM command_log WHERE id = ?').get(commandId) as { status: string };
      expect(afterLate.status).toBe('timeout');

      // Should log a warning about the late result
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ commandId }),
        expect.stringContaining('late')
      );
    });

    it('should ignore late result after completion timeout', async () => {
      const mockSocket = createMockSocket();
      const mockIo = createMockIo();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-late-completion-1';

      sendCommand(
        'test-server',
        { id: commandId, action: 'start', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      handleCommandAck('test-server', { commandId, receivedAt: new Date() });

      // Let completion timeout occur
      vi.advanceTimersByTime(COMPLETION_TIMEOUTS['start'] + 100);

      const beforeLate = db.prepare('SELECT status FROM command_log WHERE id = ?').get(commandId) as { status: string };
      expect(beforeLate.status).toBe('timeout');

      // Late result arrives
      await handleCommandResult(mockIo, 'test-server', {
        commandId,
        status: 'success',
        message: 'Late success',
      });

      // Should still be timeout
      const afterLate = db.prepare('SELECT status FROM command_log WHERE id = ?').get(commandId) as { status: string };
      expect(afterLate.status).toBe('timeout');
    });

    it('should not update deployment status on late result', async () => {
      const mockSocket = createMockSocket();
      const mockIo = createMockIo();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-late-deploy-1';

      sendCommand(
        'test-server',
        { id: commandId, action: 'install', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      // Timeout
      vi.advanceTimersByTime(ACK_TIMEOUT + 100);

      vi.mocked(updateDeploymentStatus).mockClear();

      // Late result
      await handleCommandResult(mockIo, 'test-server', {
        commandId,
        status: 'success',
      });

      // Should NOT have updated deployment status again
      expect(updateDeploymentStatus).not.toHaveBeenCalled();
    });
  });

  describe('Multiple Timeouts and Shared State', () => {
    it('should handle multiple concurrent commands independently', () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;

      // Send multiple commands
      sendCommand('test-server', { id: 'cmd-multi-1', action: 'start', appName: 'app1' }, 'deploy-1', getAgentSocket);
      sendCommand('test-server', { id: 'cmd-multi-2', action: 'start', appName: 'app2' }, 'deploy-1', getAgentSocket);
      sendCommand('test-server', { id: 'cmd-multi-3', action: 'start', appName: 'app3' }, 'deploy-1', getAgentSocket);

      expect(getPendingCommandCount()).toBe(3);

      // ACK one command
      handleCommandAck('test-server', { commandId: 'cmd-multi-2', receivedAt: new Date() });

      // Advance past ACK timeout (but not completion)
      vi.advanceTimersByTime(ACK_TIMEOUT + 100);

      // Commands 1 and 3 should timeout, 2 should still be pending
      const status1 = db.prepare('SELECT status FROM command_log WHERE id = ?').get('cmd-multi-1') as { status: string };
      const status2 = db.prepare('SELECT status FROM command_log WHERE id = ?').get('cmd-multi-2') as { status: string };
      const status3 = db.prepare('SELECT status FROM command_log WHERE id = ?').get('cmd-multi-3') as { status: string };

      expect(status1.status).toBe('timeout');
      expect(status2.status).toBe('pending'); // Was ACKed
      expect(status3.status).toBe('timeout');

      // One command still pending
      expect(getPendingCommandCount()).toBe(1);
    });

    it('should not corrupt state when timeouts fire simultaneously', () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;

      // Send multiple commands at the same time
      for (let i = 0; i < 10; i++) {
        sendCommand(
          'test-server',
          { id: `cmd-sim-${i}`, action: 'start', appName: 'test-app' },
          'deploy-1',
          getAgentSocket
        );
      }

      expect(getPendingCommandCount()).toBe(10);

      // All timeouts fire at once
      vi.advanceTimersByTime(ACK_TIMEOUT + 100);

      // All should be timed out
      for (let i = 0; i < 10; i++) {
        const status = db.prepare('SELECT status FROM command_log WHERE id = ?').get(`cmd-sim-${i}`) as { status: string };
        expect(status.status).toBe('timeout');
      }

      expect(getPendingCommandCount()).toBe(0);
    });

    it('should handle rapid command send/ack/result cycle', async () => {
      const mockSocket = createMockSocket();
      const mockIo = createMockIo();
      const getAgentSocket = () => mockSocket;

      // Rapid cycle
      for (let i = 0; i < 5; i++) {
        const commandId = `cmd-rapid-${i}`;

        sendCommand(
          'test-server',
          { id: commandId, action: 'start', appName: 'test-app' },
          'deploy-1',
          getAgentSocket
        );

        // Immediately ACK
        handleCommandAck('test-server', { commandId, receivedAt: new Date() });

        // Immediately result
        await handleCommandResult(mockIo, 'test-server', {
          commandId,
          status: 'success',
        });
      }

      // All should be successful, none pending
      expect(getPendingCommandCount()).toBe(0);

      for (let i = 0; i < 5; i++) {
        const status = db.prepare('SELECT status FROM command_log WHERE id = ?').get(`cmd-rapid-${i}`) as { status: string };
        expect(status.status).toBe('success');
      }
    });
  });

  describe('Agent Disconnect Cleanup', () => {
    it('should clean up pending commands on disconnect', () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;

      sendCommand('test-server', { id: 'cmd-dc-1', action: 'install', appName: 'app1' }, 'deploy-1', getAgentSocket);
      sendCommand('test-server', { id: 'cmd-dc-2', action: 'start', appName: 'app2' }, 'deploy-1', getAgentSocket);

      expect(getPendingCommandCount()).toBe(2);

      cleanupPendingCommandsForServer('test-server');

      expect(getPendingCommandCount()).toBe(0);

      // Commands should be marked as error
      const status1 = db.prepare('SELECT status, result_message FROM command_log WHERE id = ?').get('cmd-dc-1') as { status: string; result_message: string };
      const status2 = db.prepare('SELECT status, result_message FROM command_log WHERE id = ?').get('cmd-dc-2') as { status: string; result_message: string };

      expect(status1.status).toBe('error');
      expect(status1.result_message).toContain('disconnected');
      expect(status2.status).toBe('error');
    });

    it('should only clean up commands for the disconnected server', () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;

      // Add another server
      db.prepare(`
        INSERT INTO servers (id, name, is_core, agent_status)
        VALUES ('other-server', 'Other Server', 0, 'online')
      `).run();

      // Commands for different servers (simulated by tracking)
      sendCommand('test-server', { id: 'cmd-server1', action: 'install', appName: 'app1' }, 'deploy-1', getAgentSocket);

      // For this test, we need to manipulate the command's serverId
      // The cleanup function checks pending.serverId
      expect(getPendingCommandCount()).toBe(1);

      // Disconnect a different server
      cleanupPendingCommandsForServer('other-server');

      // Command for test-server should still be pending
      expect(getPendingCommandCount()).toBe(1);
    });

    it('should update deployment status on disconnect', () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;

      // Update deployment to installing status
      db.prepare('UPDATE deployments SET status = ? WHERE id = ?').run('installing', 'deploy-1');

      sendCommand('test-server', { id: 'cmd-dc-deploy-1', action: 'install', appName: 'test-app' }, 'deploy-1', getAgentSocket);

      cleanupPendingCommandsForServer('test-server');

      // Check deployment was updated
      const deployment = db.prepare('SELECT status, status_message FROM deployments WHERE id = ?').get('deploy-1') as { status: string; status_message: string };
      expect(deployment.status).toBe('error');
      expect(deployment.status_message).toContain('disconnected');
    });
  });

  describe('Command Result Handling', () => {
    it('should resolve promise on successful result', async () => {
      const mockSocket = createMockSocket();
      const mockIo = createMockIo();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-success-1';

      const promise = sendCommandWithResult(
        'test-server',
        { id: commandId, action: 'start', appName: 'test-app' },
        getAgentSocket,
        'deploy-1'
      );

      handleCommandAck('test-server', { commandId, receivedAt: new Date() });

      await handleCommandResult(mockIo, 'test-server', {
        commandId,
        status: 'success',
        message: 'Started successfully',
      });

      const result = await promise;
      expect(result.status).toBe('success');
      expect(result.message).toBe('Started successfully');
    });

    it('should reject promise on error result', async () => {
      const mockSocket = createMockSocket();
      const mockIo = createMockIo();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-error-1';

      const promise = sendCommandWithResult(
        'test-server',
        { id: commandId, action: 'start', appName: 'test-app' },
        getAgentSocket,
        'deploy-1'
      );

      handleCommandAck('test-server', { commandId, receivedAt: new Date() });

      await handleCommandResult(mockIo, 'test-server', {
        commandId,
        status: 'error',
        message: 'Failed to start',
      });

      await expect(promise).rejects.toThrow('Failed to start');
    });

    it('should clear timeouts on result', async () => {
      const mockSocket = createMockSocket();
      const mockIo = createMockIo();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-clear-timeout-1';

      sendCommand(
        'test-server',
        { id: commandId, action: 'start', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      handleCommandAck('test-server', { commandId, receivedAt: new Date() });

      // Result arrives before completion timeout
      await handleCommandResult(mockIo, 'test-server', {
        commandId,
        status: 'success',
      });

      // Advance past what would have been the timeout
      vi.advanceTimersByTime(COMPLETION_TIMEOUTS['start'] + 100);

      // Should still be success, not timeout
      const status = db.prepare('SELECT status FROM command_log WHERE id = ?').get(commandId) as { status: string };
      expect(status.status).toBe('success');
    });

    it('should broadcast result to authenticated clients', async () => {
      const mockSocket = createMockSocket();
      const mockIo = createMockIo();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-broadcast-1';

      sendCommand(
        'test-server',
        { id: commandId, action: 'start', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      await handleCommandResult(mockIo, 'test-server', {
        commandId,
        status: 'success',
      });

      expect(mockIo.to).toHaveBeenCalledWith('authenticated');
      expect(mockIo.emit).toHaveBeenCalledWith('command:result', expect.objectContaining({
        commandId,
        status: 'success',
        serverId: 'test-server',
      }));
    });
  });

  describe('ACK Validation', () => {
    it('should ignore ACK for unknown command', () => {
      handleCommandAck('test-server', { commandId: 'unknown-cmd', receivedAt: new Date() });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ commandId: 'unknown-cmd' }),
        expect.stringContaining('unknown command')
      );
    });

    it('should ignore ACK from wrong server', () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-wrong-server-1';

      sendCommand(
        'test-server',
        { id: commandId, action: 'start', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      // ACK from different server
      handleCommandAck('other-server', { commandId, receivedAt: new Date() });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: 'other-server',
          expectedServerId: 'test-server',
        }),
        expect.stringContaining('wrong server')
      );

      // Original command should still timeout
      vi.advanceTimersByTime(ACK_TIMEOUT + 100);

      const status = db.prepare('SELECT status FROM command_log WHERE id = ?').get(commandId) as { status: string };
      expect(status.status).toBe('timeout');
    });
  });

  describe('Utility Functions', () => {
    it('getPendingCommandCount should return correct count', () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;

      expect(getPendingCommandCount()).toBe(0);

      sendCommand('test-server', { id: 'util-1', action: 'start', appName: 'app' }, undefined, getAgentSocket);
      expect(getPendingCommandCount()).toBe(1);

      sendCommand('test-server', { id: 'util-2', action: 'start', appName: 'app' }, undefined, getAgentSocket);
      expect(getPendingCommandCount()).toBe(2);
    });

    it('hasPendingCommands should return correct boolean', () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;

      expect(hasPendingCommands()).toBe(false);

      sendCommand('test-server', { id: 'has-1', action: 'start', appName: 'app' }, undefined, getAgentSocket);
      expect(hasPendingCommands()).toBe(true);
    });

    it('abortPendingCommands should reject all pending commands', async () => {
      const mockSocket = createMockSocket();
      const getAgentSocket = () => mockSocket;

      const promise1 = sendCommandWithResult('test-server', { id: 'abort-1', action: 'start', appName: 'app' }, getAgentSocket);
      const promise2 = sendCommandWithResult('test-server', { id: 'abort-2', action: 'start', appName: 'app' }, getAgentSocket);

      expect(getPendingCommandCount()).toBe(2);

      abortPendingCommands();

      expect(getPendingCommandCount()).toBe(0);

      await expect(promise1).rejects.toThrow('shutting down');
      await expect(promise2).rejects.toThrow('shutting down');
    });
  });

  describe('Agent Not Connected', () => {
    it('sendCommand should return false if agent not connected', () => {
      const getAgentSocket = () => undefined;

      const result = sendCommand(
        'test-server',
        { id: 'no-agent-1', action: 'start', appName: 'app' },
        'deploy-1',
        getAgentSocket
      );

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: 'test-server' }),
        expect.stringContaining('not connected')
      );
    });

    it('sendCommandWithResult should reject if agent not connected', async () => {
      const getAgentSocket = () => undefined;

      await expect(
        sendCommandWithResult(
          'test-server',
          { id: 'no-agent-2', action: 'start', appName: 'app' },
          getAgentSocket
        )
      ).rejects.toThrow('Agent not connected');
    });
  });

  describe('Deployment Status Mapping', () => {
    it('should map install success to stopped status', async () => {
      const mockSocket = createMockSocket();
      const mockIo = createMockIo();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-map-install-1';

      sendCommand(
        'test-server',
        { id: commandId, action: 'install', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      handleCommandAck('test-server', { commandId, receivedAt: new Date() });

      await handleCommandResult(mockIo, 'test-server', {
        commandId,
        status: 'success',
      });

      expect(updateDeploymentStatus).toHaveBeenCalledWith('deploy-1', 'stopped', undefined);
    });

    it('should map start success to running status', async () => {
      const mockSocket = createMockSocket();
      const mockIo = createMockIo();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-map-start-1';

      sendCommand(
        'test-server',
        { id: commandId, action: 'start', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      handleCommandAck('test-server', { commandId, receivedAt: new Date() });

      await handleCommandResult(mockIo, 'test-server', {
        commandId,
        status: 'success',
      });

      expect(updateDeploymentStatus).toHaveBeenCalledWith('deploy-1', 'running', undefined);
    });

    it('should map any error to error status', async () => {
      const mockSocket = createMockSocket();
      const mockIo = createMockIo();
      const getAgentSocket = () => mockSocket;
      const commandId = 'cmd-map-error-1';

      sendCommand(
        'test-server',
        { id: commandId, action: 'start', appName: 'test-app' },
        'deploy-1',
        getAgentSocket
      );

      handleCommandAck('test-server', { commandId, receivedAt: new Date() });

      await handleCommandResult(mockIo, 'test-server', {
        commandId,
        status: 'error',
        message: 'Something failed',
      });

      expect(updateDeploymentStatus).toHaveBeenCalledWith('deploy-1', 'error', 'Something failed');
    });
  });
});
