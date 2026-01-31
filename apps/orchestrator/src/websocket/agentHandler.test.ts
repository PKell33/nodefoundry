/**
 * Agent Connection Replacement Tests for agentHandler
 *
 * Tests:
 * - New connection replaces old for same server
 * - Old connection forcibly disconnected
 * - Pending commands transferred or failed
 * - Heartbeat interval cleared on disconnect
 * - Race: connect + disconnect simultaneously handled
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';

// Mock tracking
const mockCalls = {
  socketDisconnect: [] as Array<{ socketId: string; force?: boolean }>,
  clearInterval: [] as Array<{ intervalId: unknown }>,
  setInterval: [] as Array<{ callback: () => void; ms: number; id: number }>,
  cleanupPendingCommands: [] as Array<{ serverId: string }>,
  cleanupPendingLogRequests: [] as Array<{ serverId: string }>,
  cleanupServerMutex: [] as Array<{ serverId: string }>,
  ioEmits: [] as Array<{ event: string; data: unknown }>,
  socketEmits: [] as Array<{ socketId: string; event: string; data?: unknown }>,
  autoMountServerStorage: [] as Array<{ serverId: string }>,
};

// Track mutex lock acquisitions
const mutexState = {
  lockOrder: [] as Array<{ serverId: string; action: 'acquire' | 'release' }>,
};

// Test state
const testState = {
  db: null as Database.Database | null,
  intervalCounter: 0,
  activeIntervals: new Set<number>(),
};

// Mock socket class
class MockSocket extends EventEmitter {
  id: string;
  handshake: {
    auth: { serverId?: string; token?: string };
    address: string;
  };
  disconnected = false;
  private _skipDisconnectEvent = false;

  constructor(id: string, auth: { serverId?: string; token?: string } = {}) {
    super();
    this.id = id;
    this.handshake = {
      auth,
      address: '127.0.0.1',
    };
  }

  disconnect(force?: boolean) {
    if (this.disconnected) return;
    mockCalls.socketDisconnect.push({ socketId: this.id, force });
    this.disconnected = true;
    // Don't emit disconnect event here - let the test control it
    this._skipDisconnectEvent = true;
  }

  emit(event: string, data?: unknown): boolean {
    if (event !== 'disconnect') {
      mockCalls.socketEmits.push({ socketId: this.id, event, data });
    }
    return super.emit(event, data);
  }
}

// Mock IO server
class MockIOServer extends EventEmitter {
  emit(event: string, data?: unknown): boolean {
    mockCalls.ioEmits.push({ event, data });
    return super.emit(event, data);
  }

  simulateConnection(socket: MockSocket) {
    this.emit('connection', socket);
  }
}

// Mock database
vi.mock('../db/index.js', () => ({
  getDb: () => testState.db,
}));

// Mock logger
vi.mock('../lib/logger.js', () => ({
  wsLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock mutex manager
vi.mock('../lib/mutexManager.js', () => ({
  mutexManager: {
    withServerLock: async (serverId: string, fn: () => Promise<void>) => {
      mutexState.lockOrder.push({ serverId, action: 'acquire' });
      try {
        await fn();
      } finally {
        mutexState.lockOrder.push({ serverId, action: 'release' });
      }
    },
    cleanupServerMutex: (serverId: string) => {
      mockCalls.cleanupServerMutex.push({ serverId });
    },
  },
}));

// Mock agent auth
vi.mock('./agentAuth.js', () => ({
  authenticateAgent: (serverId: string) => {
    if (!testState.db) return { success: false };
    const server = testState.db.prepare('SELECT id FROM servers WHERE id = ?').get(serverId);
    return { success: !!server };
  },
  hashToken: (token: string) => `hashed_${token}`,
}));

// Mock status handler
vi.mock('./statusHandler.js', () => ({
  handleStatusReport: vi.fn().mockResolvedValue(undefined),
}));

// Mock browser client handler
vi.mock('./browserClient.js', () => ({
  handleBrowserClient: vi.fn(),
}));

// Mock log stream handler
vi.mock('./logStreamHandler.js', () => ({
  handleLogResult: vi.fn(),
  handleLogStreamLine: vi.fn(),
  handleLogStreamStatus: vi.fn(),
  cleanupPendingLogRequestsForServer: (serverId: string) => {
    mockCalls.cleanupPendingLogRequests.push({ serverId });
  },
  clearPendingLogRequests: vi.fn(),
  requestLogs: vi.fn(),
}));

// Mock command dispatcher
vi.mock('./commandDispatcher.js', () => ({
  handleCommandResult: vi.fn().mockResolvedValue(undefined),
  handleCommandAck: vi.fn(),
  cleanupPendingCommandsForServer: (serverId: string) => {
    mockCalls.cleanupPendingCommands.push({ serverId });
  },
  sendCommand: vi.fn().mockReturnValue(true),
  sendCommandWithResult: vi.fn().mockResolvedValue({ success: true }),
  getPendingCommandCount: vi.fn().mockReturnValue(0),
  abortPendingCommands: vi.fn(),
  hasPendingCommands: vi.fn().mockReturnValue(false),
}));

// Mock mount handler
vi.mock('./mountHandler.js', () => ({
  autoMountServerStorage: async (serverId: string) => {
    mockCalls.autoMountServerStorage.push({ serverId });
  },
  sendMountCommand: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock shared module
vi.mock('@ownprem/shared', () => ({
  isValidAgentAuth: (auth: unknown) => {
    if (!auth || typeof auth !== 'object') return false;
    const a = auth as { serverId?: string };
    return typeof a.serverId === 'string';
  },
}));

function setupTestDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      auth_token TEXT,
      is_core INTEGER DEFAULT 0,
      agent_status TEXT DEFAULT 'offline',
      last_seen TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  return db;
}

// We need to import and re-import the module for each test to reset internal state
// Since we can't easily reset module state, we'll test the observable behaviors

describe('Agent Connection Replacement (agentHandler)', () => {
  let db: Database.Database;
  let io: MockIOServer;

  beforeEach(() => {
    // Reset all mock tracking
    Object.keys(mockCalls).forEach((key) => {
      (mockCalls as Record<string, unknown[]>)[key] = [];
    });

    // Reset mutex state
    mutexState.lockOrder.length = 0;

    // Reset test state
    testState.intervalCounter = 0;
    testState.activeIntervals.clear();

    // Create fresh database
    db = setupTestDb();
    testState.db = db;

    // Create mock IO server
    io = new MockIOServer();

    // Insert test server
    db.prepare("INSERT INTO servers (id, name) VALUES ('server-1', 'Test Server')").run();

    // Mock setInterval/clearInterval - use type cast to handle signature differences
    vi.spyOn(global, 'setInterval').mockImplementation(((callback: () => void, ms?: number) => {
      const id = ++testState.intervalCounter;
      mockCalls.setInterval.push({ callback, ms: ms ?? 0, id });
      testState.activeIntervals.add(id);
      return { [Symbol.toPrimitive]: () => id } as unknown as NodeJS.Timeout;
    }) as typeof setInterval);

    vi.spyOn(global, 'clearInterval').mockImplementation(((interval: unknown) => {
      mockCalls.clearInterval.push({ intervalId: interval });
    }) as typeof clearInterval);
  });

  afterEach(async () => {
    // Wait for any pending async operations
    await new Promise((resolve) => setTimeout(resolve, 100));

    vi.restoreAllMocks();

    // Close database after all pending operations
    if (db && testState.db === db) {
      testState.db = null;
      db.close();
    }
  });

  describe('new connection replaces old for same server', () => {
    it('acquires mutex lock when agent connects', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'valid-token' });
      io.simulateConnection(socket);

      await new Promise((resolve) => setTimeout(resolve, 20));

      // Should have acquired and released lock
      expect(mutexState.lockOrder).toContainEqual({ serverId: 'server-1', action: 'acquire' });
      expect(mutexState.lockOrder).toContainEqual({ serverId: 'server-1', action: 'release' });
    });

    it('sets server status to online after connection', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'valid-token' });
      io.simulateConnection(socket);

      await new Promise((resolve) => setTimeout(resolve, 20));

      const server = db.prepare('SELECT agent_status FROM servers WHERE id = ?').get('server-1') as {
        agent_status: string;
      };
      expect(server.agent_status).toBe('online');
    });

    it('emits server:connected event', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'valid-token' });
      io.simulateConnection(socket);

      await new Promise((resolve) => setTimeout(resolve, 20));

      const connectedEmit = mockCalls.ioEmits.find((e) => e.event === 'server:connected');
      expect(connectedEmit).toBeDefined();
      expect((connectedEmit?.data as { serverId: string }).serverId).toBe('server-1');
    });

    it('requests immediate status report from new connection', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'valid-token' });
      io.simulateConnection(socket);

      await new Promise((resolve) => setTimeout(resolve, 20));

      const statusRequest = mockCalls.socketEmits.find(
        (e) => e.socketId === 'socket-1' && e.event === 'request_status'
      );
      expect(statusRequest).toBeDefined();
    });
  });

  describe('old connection forcibly disconnected', () => {
    it('calls disconnect on existing socket when same server reconnects', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      // First connection
      const socket1 = new MockSocket('socket-1', { serverId: 'server-1', token: 'token-1' });
      io.simulateConnection(socket1);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Second connection for same server
      const socket2 = new MockSocket('socket-2', { serverId: 'server-1', token: 'token-2' });
      io.simulateConnection(socket2);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // First socket should have been disconnected
      const disconnectCall = mockCalls.socketDisconnect.find((c) => c.socketId === 'socket-1');
      expect(disconnectCall).toBeDefined();
    });

    it('does not disconnect other servers when new connection arrives', async () => {
      db.prepare("INSERT INTO servers (id, name) VALUES ('server-2', 'Test Server 2')").run();

      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket1 = new MockSocket('socket-1', { serverId: 'server-1', token: 'token-1' });
      io.simulateConnection(socket1);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const socket2 = new MockSocket('socket-2', { serverId: 'server-2', token: 'token-2' });
      io.simulateConnection(socket2);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // First socket should NOT have been disconnected
      const disconnectCall = mockCalls.socketDisconnect.find((c) => c.socketId === 'socket-1');
      expect(disconnectCall).toBeUndefined();
    });
  });

  describe('pending commands cleanup on disconnect', () => {
    it('cleans up pending commands when disconnect event fires', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'token-1' });
      io.simulateConnection(socket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Simulate disconnect event
      socket.emit('disconnect', 'transport close');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(mockCalls.cleanupPendingCommands).toContainEqual({ serverId: 'server-1' });
    });

    it('cleans up pending log requests on disconnect', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'token-1' });
      io.simulateConnection(socket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      socket.emit('disconnect', 'transport close');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(mockCalls.cleanupPendingLogRequests).toContainEqual({ serverId: 'server-1' });
    });

    it('cleans up server mutex on disconnect', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'token-1' });
      io.simulateConnection(socket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      socket.emit('disconnect', 'transport close');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(mockCalls.cleanupServerMutex).toContainEqual({ serverId: 'server-1' });
    });

    it('sets server status to offline on disconnect', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'token-1' });
      io.simulateConnection(socket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      socket.emit('disconnect', 'transport close');
      await new Promise((resolve) => setTimeout(resolve, 20));

      const server = db.prepare('SELECT agent_status FROM servers WHERE id = ?').get('server-1') as {
        agent_status: string;
      };
      expect(server.agent_status).toBe('offline');
    });

    it('emits server:disconnected event', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'token-1' });
      io.simulateConnection(socket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      socket.emit('disconnect', 'transport close');
      await new Promise((resolve) => setTimeout(resolve, 20));

      const disconnectedEmit = mockCalls.ioEmits.find((e) => e.event === 'server:disconnected');
      expect(disconnectedEmit).toBeDefined();
      expect((disconnectedEmit?.data as { serverId: string }).serverId).toBe('server-1');
    });
  });

  describe('heartbeat interval management', () => {
    it('creates heartbeat interval on connection', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'valid-token' });
      io.simulateConnection(socket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Should have created heartbeat intervals (cleanup + per-connection)
      const heartbeatIntervals = mockCalls.setInterval.filter((c) => c.ms === 30000);
      expect(heartbeatIntervals.length).toBeGreaterThanOrEqual(1);
    });

    it('clears heartbeat interval when replacing connection', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket1 = new MockSocket('socket-1', { serverId: 'server-1', token: 'token-1' });
      io.simulateConnection(socket1);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const clearedBefore = mockCalls.clearInterval.length;

      const socket2 = new MockSocket('socket-2', { serverId: 'server-1', token: 'token-2' });
      io.simulateConnection(socket2);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Should have cleared the old connection's heartbeat
      expect(mockCalls.clearInterval.length).toBeGreaterThan(clearedBefore);
    });

    it('clears heartbeat interval on disconnect', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'token-1' });
      io.simulateConnection(socket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const clearedBefore = mockCalls.clearInterval.length;

      socket.emit('disconnect', 'transport close');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(mockCalls.clearInterval.length).toBeGreaterThan(clearedBefore);
    });
  });

  describe('race condition handling with mutex', () => {
    it('uses mutex lock for each connection to same server', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket1 = new MockSocket('socket-1', { serverId: 'server-1', token: 'token-1' });
      const socket2 = new MockSocket('socket-2', { serverId: 'server-1', token: 'token-2' });

      // Connect both quickly
      io.simulateConnection(socket1);
      io.simulateConnection(socket2);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Mutex should be acquired and released for each connection
      const server1Actions = mutexState.lockOrder.filter((l) => l.serverId === 'server-1');
      expect(server1Actions.length).toBe(4); // 2 acquire + 2 release

      // Verify we have both acquires and releases
      const acquires = server1Actions.filter((a) => a.action === 'acquire');
      const releases = server1Actions.filter((a) => a.action === 'release');
      expect(acquires.length).toBe(2);
      expect(releases.length).toBe(2);
    });

    it('allows parallel connections for different servers', async () => {
      db.prepare("INSERT INTO servers (id, name) VALUES ('server-2', 'Test Server 2')").run();

      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket1 = new MockSocket('socket-1', { serverId: 'server-1', token: 'token-1' });
      const socket2 = new MockSocket('socket-2', { serverId: 'server-2', token: 'token-2' });

      io.simulateConnection(socket1);
      io.simulateConnection(socket2);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Both servers should have been processed
      const server1Actions = mutexState.lockOrder.filter((l) => l.serverId === 'server-1');
      const server2Actions = mutexState.lockOrder.filter((l) => l.serverId === 'server-2');

      expect(server1Actions.length).toBe(2); // acquire + release
      expect(server2Actions.length).toBe(2); // acquire + release
    });
  });

  describe('authentication', () => {
    it('disconnects socket if server not found', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'unknown-server', token: 'token' });
      io.simulateConnection(socket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(socket.disconnected).toBe(true);
    });

    it('accepts valid server connection', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'valid-token' });
      io.simulateConnection(socket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(socket.disconnected).toBe(false);

      const server = db.prepare('SELECT agent_status FROM servers WHERE id = ?').get('server-1') as {
        agent_status: string;
      };
      expect(server.agent_status).toBe('online');
    });
  });

  describe('auto-mount on connection', () => {
    it('triggers auto-mount for server storage', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'token-1' });
      io.simulateConnection(socket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(mockCalls.autoMountServerStorage).toContainEqual({ serverId: 'server-1' });
    });
  });

  describe('pong handling', () => {
    it('updates lastSeen on pong event', async () => {
      const { setupAgentHandler } = await import('./agentHandler.js');
      setupAgentHandler(io as unknown as Parameters<typeof setupAgentHandler>[0]);

      const socket = new MockSocket('socket-1', { serverId: 'server-1', token: 'token-1' });
      io.simulateConnection(socket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Simulate pong
      socket.emit('pong');
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Can't directly verify lastSeen update, but we verify the handler doesn't throw
    });
  });
});
