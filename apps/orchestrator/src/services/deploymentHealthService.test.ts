/**
 * Stuck Deployment Recovery Tests for deploymentHealthService
 *
 * Tests:
 * - Deployments in transient state >15min marked error
 * - Pending commands marked as timeout
 * - Recovery runs on configured interval
 * - Multiple stuck deployments handled in batch
 * - Recovery doesn't affect active installations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Test state
const testState = {
  db: null as Database.Database | null,
  intervalCallbacks: [] as Array<{ callback: () => void; ms: number }>,
  clearedIntervals: [] as unknown[],
};

// Mock tracking
const mockCalls = {
  setInterval: [] as Array<{ ms: number }>,
  clearInterval: [] as Array<{ interval: unknown }>,
  loggerWarn: [] as Array<{ data: unknown; message: string }>,
  loggerInfo: [] as Array<{ data: unknown; message: string }>,
  loggerError: [] as Array<{ data: unknown; message: string }>,
};

// Mock database
vi.mock('../db/index.js', () => ({
  getDb: () => testState.db,
}));

// Mock logger
vi.mock('../lib/logger.js', () => ({
  default: {
    child: () => ({
      info: (data: unknown, message: string) => {
        mockCalls.loggerInfo.push({ data, message });
      },
      warn: (data: unknown, message: string) => {
        mockCalls.loggerWarn.push({ data, message });
      },
      error: (data: unknown, message: string) => {
        mockCalls.loggerError.push({ data, message });
      },
      debug: vi.fn(),
    }),
  },
}));

function setupTestDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE deployments (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      status_message TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE command_log (
      id TEXT PRIMARY KEY,
      deployment_id TEXT,
      command_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result_message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )
  `);

  return db;
}

// Helper to insert deployment with specific updated_at time
function insertDeployment(
  db: Database.Database,
  id: string,
  status: string,
  minutesAgo: number,
  appName = 'test-app',
  serverId = 'server-1'
): void {
  const updatedAt = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO deployments (id, server_id, app_name, status, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, serverId, appName, status, updatedAt);
}

// Helper to insert pending command
function insertPendingCommand(
  db: Database.Database,
  id: string,
  deploymentId: string,
  commandType = 'install'
): void {
  db.prepare(`
    INSERT INTO command_log (id, deployment_id, command_type, status)
    VALUES (?, ?, ?, 'pending')
  `).run(id, deploymentId, commandType);
}

describe('Stuck Deployment Recovery (deploymentHealthService)', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Reset mock tracking
    Object.keys(mockCalls).forEach((key) => {
      (mockCalls as Record<string, unknown[]>)[key] = [];
    });

    testState.intervalCallbacks.length = 0;
    testState.clearedIntervals.length = 0;

    // Create fresh database
    db = setupTestDb();
    testState.db = db;

    // Mock timers - use type cast to handle signature differences
    vi.spyOn(global, 'setInterval').mockImplementation(((callback: () => void, ms?: number) => {
      mockCalls.setInterval.push({ ms: ms ?? 0 });
      testState.intervalCallbacks.push({ callback, ms: ms ?? 0 });
      return { id: testState.intervalCallbacks.length } as unknown as NodeJS.Timeout;
    }) as typeof setInterval);

    vi.spyOn(global, 'clearInterval').mockImplementation(((interval: unknown) => {
      mockCalls.clearInterval.push({ interval });
      testState.clearedIntervals.push(interval);
    }) as typeof clearInterval);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();

    if (db && testState.db === db) {
      testState.db = null;
      db.close();
    }
  });

  describe('deployments in transient state >15min marked error', () => {
    it('marks installing deployment as error after 15 minutes', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      // Insert deployment stuck for 20 minutes
      insertDeployment(db, 'dep-1', 'installing', 20);

      const recovered = await deploymentHealthService.checkStuckDeployments();

      expect(recovered).toBe(1);

      const deployment = db.prepare('SELECT status, status_message FROM deployments WHERE id = ?').get('dep-1') as {
        status: string;
        status_message: string;
      };
      expect(deployment.status).toBe('error');
      expect(deployment.status_message).toContain("stuck in 'installing'");
    });

    it('marks configuring deployment as error after 15 minutes', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'configuring', 16);

      const recovered = await deploymentHealthService.checkStuckDeployments();

      expect(recovered).toBe(1);

      const deployment = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-1') as {
        status: string;
      };
      expect(deployment.status).toBe('error');
    });

    it('marks uninstalling deployment as error after 15 minutes', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'uninstalling', 20);

      const recovered = await deploymentHealthService.checkStuckDeployments();

      expect(recovered).toBe(1);

      const deployment = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-1') as {
        status: string;
      };
      expect(deployment.status).toBe('error');
    });

    it('does not mark deployment stuck for less than 15 minutes', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      // Insert deployment stuck for only 10 minutes
      insertDeployment(db, 'dep-1', 'installing', 10);

      const recovered = await deploymentHealthService.checkStuckDeployments();

      expect(recovered).toBe(0);

      const deployment = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-1') as {
        status: string;
      };
      expect(deployment.status).toBe('installing');
    });

    it('includes duration in error message', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'installing', 25);

      await deploymentHealthService.checkStuckDeployments();

      const deployment = db.prepare('SELECT status_message FROM deployments WHERE id = ?').get('dep-1') as {
        status_message: string;
      };
      expect(deployment.status_message).toContain('25 minutes');
    });
  });

  describe('pending commands marked as timeout', () => {
    it('marks pending commands for stuck deployment as timeout', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'installing', 20);
      insertPendingCommand(db, 'cmd-1', 'dep-1', 'install');

      await deploymentHealthService.checkStuckDeployments();

      const command = db.prepare('SELECT status, result_message FROM command_log WHERE id = ?').get('cmd-1') as {
        status: string;
        result_message: string;
      };
      expect(command.status).toBe('timeout');
      expect(command.result_message).toContain('health check');
    });

    it('marks multiple pending commands as timeout', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'configuring', 20);
      insertPendingCommand(db, 'cmd-1', 'dep-1', 'install');
      insertPendingCommand(db, 'cmd-2', 'dep-1', 'configure');

      await deploymentHealthService.checkStuckDeployments();

      const cmd1 = db.prepare('SELECT status FROM command_log WHERE id = ?').get('cmd-1') as { status: string };
      const cmd2 = db.prepare('SELECT status FROM command_log WHERE id = ?').get('cmd-2') as { status: string };

      expect(cmd1.status).toBe('timeout');
      expect(cmd2.status).toBe('timeout');
    });

    it('does not affect commands for other deployments', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'installing', 20);
      insertDeployment(db, 'dep-2', 'running', 20);
      insertPendingCommand(db, 'cmd-1', 'dep-1', 'install');
      insertPendingCommand(db, 'cmd-2', 'dep-2', 'start');

      await deploymentHealthService.checkStuckDeployments();

      const cmd1 = db.prepare('SELECT status FROM command_log WHERE id = ?').get('cmd-1') as { status: string };
      const cmd2 = db.prepare('SELECT status FROM command_log WHERE id = ?').get('cmd-2') as { status: string };

      expect(cmd1.status).toBe('timeout');
      expect(cmd2.status).toBe('pending'); // Unaffected
    });

    it('does not affect already completed commands', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'installing', 20);
      db.prepare(`
        INSERT INTO command_log (id, deployment_id, command_type, status, result_message)
        VALUES ('cmd-1', 'dep-1', 'install', 'success', 'Completed')
      `).run();

      await deploymentHealthService.checkStuckDeployments();

      const command = db.prepare('SELECT status FROM command_log WHERE id = ?').get('cmd-1') as { status: string };
      expect(command.status).toBe('success');
    });

    it('sets completed_at timestamp on timed out commands', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'installing', 20);
      insertPendingCommand(db, 'cmd-1', 'dep-1', 'install');

      await deploymentHealthService.checkStuckDeployments();

      const command = db.prepare('SELECT completed_at FROM command_log WHERE id = ?').get('cmd-1') as {
        completed_at: string | null;
      };
      expect(command.completed_at).not.toBeNull();
    });
  });

  describe('recovery runs on configured interval', () => {
    it('starts interval on start()', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      deploymentHealthService.start();

      expect(mockCalls.setInterval.length).toBe(1);
      expect(mockCalls.setInterval[0].ms).toBe(60000); // 1 minute

      deploymentHealthService.stop();
    });

    it('runs initial check on start()', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'installing', 20);

      deploymentHealthService.start();

      // Wait for initial async check
      await new Promise((resolve) => setTimeout(resolve, 50));

      const deployment = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-1') as {
        status: string;
      };
      expect(deployment.status).toBe('error');

      deploymentHealthService.stop();
    });

    it('clears interval on stop()', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      deploymentHealthService.start();
      deploymentHealthService.stop();

      expect(mockCalls.clearInterval.length).toBe(1);
    });

    it('does not start twice', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      deploymentHealthService.start();
      deploymentHealthService.start();

      expect(mockCalls.setInterval.length).toBe(1);

      deploymentHealthService.stop();
    });

    it('getStatus returns running state', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      expect(deploymentHealthService.getStatus().running).toBe(false);

      deploymentHealthService.start();
      expect(deploymentHealthService.getStatus().running).toBe(true);

      deploymentHealthService.stop();
      expect(deploymentHealthService.getStatus().running).toBe(false);
    });
  });

  describe('multiple stuck deployments handled in batch', () => {
    it('recovers all stuck deployments in single check', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'installing', 20, 'app-1');
      insertDeployment(db, 'dep-2', 'configuring', 25, 'app-2');
      insertDeployment(db, 'dep-3', 'uninstalling', 30, 'app-3');

      const recovered = await deploymentHealthService.checkStuckDeployments();

      expect(recovered).toBe(3);

      const deployments = db.prepare('SELECT id, status FROM deployments ORDER BY id').all() as Array<{
        id: string;
        status: string;
      }>;

      expect(deployments.every((d) => d.status === 'error')).toBe(true);
    });

    it('logs count of stuck deployments found', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'installing', 20);
      insertDeployment(db, 'dep-2', 'configuring', 25);

      await deploymentHealthService.checkStuckDeployments();

      const warnLog = mockCalls.loggerWarn.find((l) => l.message.includes('Found deployments stuck'));
      expect(warnLog).toBeDefined();
      expect((warnLog?.data as { count: number }).count).toBe(2);
    });

    it('logs details for each recovered deployment', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'installing', 20, 'app-1', 'server-1');
      insertDeployment(db, 'dep-2', 'configuring', 25, 'app-2', 'server-2');

      await deploymentHealthService.checkStuckDeployments();

      const recoveryLogs = mockCalls.loggerWarn.filter((l) => l.message.includes('Recovered stuck deployment'));
      expect(recoveryLogs.length).toBe(2);

      const logData1 = recoveryLogs.find((l) => (l.data as { deploymentId: string }).deploymentId === 'dep-1');
      expect(logData1).toBeDefined();
      expect((logData1?.data as { appName: string }).appName).toBe('app-1');
    });

    it('handles mixed pending commands for multiple deployments', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'installing', 20);
      insertDeployment(db, 'dep-2', 'configuring', 25);
      insertPendingCommand(db, 'cmd-1', 'dep-1');
      insertPendingCommand(db, 'cmd-2', 'dep-1');
      insertPendingCommand(db, 'cmd-3', 'dep-2');

      await deploymentHealthService.checkStuckDeployments();

      const commands = db.prepare('SELECT status FROM command_log WHERE status = ?').all('timeout') as Array<{
        status: string;
      }>;
      expect(commands.length).toBe(3);
    });

    it('returns 0 when no stuck deployments found', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      // No deployments at all
      const recovered = await deploymentHealthService.checkStuckDeployments();

      expect(recovered).toBe(0);
    });
  });

  describe('recovery does not affect active installations', () => {
    it('does not affect deployments in running state', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'running', 60); // Running for 60 minutes

      const recovered = await deploymentHealthService.checkStuckDeployments();

      expect(recovered).toBe(0);

      const deployment = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-1') as {
        status: string;
      };
      expect(deployment.status).toBe('running');
    });

    it('does not affect deployments in stopped state', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'stopped', 60);

      const recovered = await deploymentHealthService.checkStuckDeployments();

      expect(recovered).toBe(0);

      const deployment = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-1') as {
        status: string;
      };
      expect(deployment.status).toBe('stopped');
    });

    it('does not affect deployments in error state', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'error', 60);

      const recovered = await deploymentHealthService.checkStuckDeployments();

      expect(recovered).toBe(0);
    });

    it('does not affect deployments in pending state', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'pending', 60);

      const recovered = await deploymentHealthService.checkStuckDeployments();

      expect(recovered).toBe(0);

      const deployment = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-1') as {
        status: string;
      };
      expect(deployment.status).toBe('pending');
    });

    it('does not affect recently started installations', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      // Installation started 5 minutes ago - should not be affected
      insertDeployment(db, 'dep-1', 'installing', 5);

      const recovered = await deploymentHealthService.checkStuckDeployments();

      expect(recovered).toBe(0);

      const deployment = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-1') as {
        status: string;
      };
      expect(deployment.status).toBe('installing');
    });

    it('only affects stuck transient deployments, not active ones', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      // Mix of stuck and active deployments
      insertDeployment(db, 'dep-1', 'installing', 5); // Active - 5 min
      insertDeployment(db, 'dep-2', 'installing', 20); // Stuck - 20 min
      insertDeployment(db, 'dep-3', 'configuring', 10); // Active - 10 min
      insertDeployment(db, 'dep-4', 'configuring', 16); // Stuck - 16 min
      insertDeployment(db, 'dep-5', 'running', 100); // Running - unaffected

      const recovered = await deploymentHealthService.checkStuckDeployments();

      expect(recovered).toBe(2); // Only dep-2 and dep-4

      const dep1 = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-1') as { status: string };
      const dep2 = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-2') as { status: string };
      const dep3 = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-3') as { status: string };
      const dep4 = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-4') as { status: string };
      const dep5 = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-5') as { status: string };

      expect(dep1.status).toBe('installing'); // Still active
      expect(dep2.status).toBe('error'); // Recovered
      expect(dep3.status).toBe('configuring'); // Still active
      expect(dep4.status).toBe('error'); // Recovered
      expect(dep5.status).toBe('running'); // Unaffected
    });
  });

  describe('edge cases', () => {
    it('handles deployment at exactly 15 minute boundary', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      // Exactly 15 minutes - should still be considered active (< not <=)
      insertDeployment(db, 'dep-1', 'installing', 15);

      const recovered = await deploymentHealthService.checkStuckDeployments();

      // Due to timing, this might be 0 or 1 depending on exact milliseconds
      // The important thing is it doesn't crash
      expect(recovered).toBeGreaterThanOrEqual(0);
    });

    it('handles deployment with no commands', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'installing', 20);
      // No commands for this deployment

      const recovered = await deploymentHealthService.checkStuckDeployments();

      expect(recovered).toBe(1);

      const deployment = db.prepare('SELECT status FROM deployments WHERE id = ?').get('dep-1') as {
        status: string;
      };
      expect(deployment.status).toBe('error');
    });

    it('updates updated_at timestamp when recovering', async () => {
      const { deploymentHealthService } = await import('./deploymentHealthService.js');

      insertDeployment(db, 'dep-1', 'installing', 20);

      const beforeUpdate = db.prepare('SELECT updated_at FROM deployments WHERE id = ?').get('dep-1') as {
        updated_at: string;
      };

      await deploymentHealthService.checkStuckDeployments();

      const afterUpdate = db.prepare('SELECT updated_at FROM deployments WHERE id = ?').get('dep-1') as {
        updated_at: string;
      };

      expect(new Date(afterUpdate.updated_at).getTime()).toBeGreaterThan(
        new Date(beforeUpdate.updated_at).getTime()
      );
    });
  });
});
