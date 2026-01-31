/**
 * Mount Credential Security Tests
 *
 * Tests:
 * - Credentials written to /run (tmpfs, not persistent)
 * - Credentials file has mode 0o400
 * - Credentials overwritten before deletion
 * - Finally block runs on mount failure
 * - Credentials not logged in error messages
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Track all file operations for verification
interface FileOperation {
  type: 'mkdtemp' | 'write' | 'unlink' | 'rmdir' | 'mkdir' | 'exists';
  path: string;
  content?: string;
  mode?: number;
}

// Global state to track operations (accessible to mocks)
const state = {
  fileOperations: [] as FileOperation[],
  logMessages: [] as { level: string; message: string; args: unknown[] }[],
  tempDirCounter: 0,
  spawnSyncBehavior: 'default' as 'default' | 'mount-fail' | 'already-mounted',
  unlinkShouldThrow: false,
  runExists: true,
};

// Mock fs module
vi.mock('fs', () => ({
  existsSync: (path: string) => {
    state.fileOperations.push({ type: 'exists', path });
    if (path === '/run') return state.runExists;
    return false;
  },
  mkdirSync: (path: string) => {
    state.fileOperations.push({ type: 'mkdir', path });
  },
  writeFileSync: (path: string, content: string, options?: { mode?: number }) => {
    state.fileOperations.push({
      type: 'write',
      path,
      content,
      mode: options?.mode,
    });
  },
  unlinkSync: (path: string) => {
    if (state.unlinkShouldThrow) {
      throw new Error('File already deleted');
    }
    state.fileOperations.push({ type: 'unlink', path });
  },
  rmdirSync: (path: string) => {
    state.fileOperations.push({ type: 'rmdir', path });
  },
  mkdtempSync: (prefix: string) => {
    const dir = `${prefix}${++state.tempDirCounter}`;
    state.fileOperations.push({ type: 'mkdtemp', path: dir });
    return dir;
  },
}));

// Mock child_process - store calls for later inspection
const spawnSyncCalls: unknown[][] = [];

vi.mock('child_process', () => ({
  spawnSync: (cmd: string, args: string[], opts: unknown) => {
    spawnSyncCalls.push([cmd, args, opts]);

    if (state.spawnSyncBehavior === 'already-mounted' && cmd === 'findmnt') {
      return { status: 0, stdout: '/mnt/share cifs', stderr: '' };
    }

    if (cmd === 'findmnt') {
      return { status: 1, stdout: '', stderr: '' };
    }

    if (state.spawnSyncBehavior === 'mount-fail' && cmd === 'mount') {
      return { status: 1, stdout: '', stderr: 'Permission denied' };
    }

    return { status: 0, stdout: '', stderr: '' };
  },
}));

// Mock privileged client to force fallback to direct mount
vi.mock('../privilegedClient.js', () => ({
  privilegedClient: {
    mount: () => Promise.reject(new Error('Privileged helper unavailable')),
    umount: () => Promise.reject(new Error('Privileged helper unavailable')),
  },
}));

// Mock logger
vi.mock('../lib/logger.js', () => ({
  default: {
    child: () => ({
      info: (msg: string, ...args: unknown[]) => state.logMessages.push({ level: 'info', message: msg, args }),
      warn: (msg: string, ...args: unknown[]) => state.logMessages.push({ level: 'warn', message: msg, args }),
      error: (msg: string, ...args: unknown[]) => state.logMessages.push({ level: 'error', message: msg, args }),
      debug: (msg: string, ...args: unknown[]) => state.logMessages.push({ level: 'debug', message: msg, args }),
    }),
  },
}));

// Import after mocks are set up
import { mountStorage } from './mountManager.js';

describe('Mount Credential Security', () => {
  beforeEach(() => {
    state.fileOperations.length = 0;
    state.logMessages.length = 0;
    state.tempDirCounter = 0;
    state.spawnSyncBehavior = 'default';
    state.unlinkShouldThrow = false;
    state.runExists = true;
    spawnSyncCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('credentials written to /run (tmpfs)', () => {
    it('creates temp directory in /run when available', async () => {
      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'testuser',
          password: 'testpass',
        },
      });

      const mkdtempOp = state.fileOperations.find((op) => op.type === 'mkdtemp');
      expect(mkdtempOp).toBeDefined();
      expect(mkdtempOp!.path).toMatch(/^\/run\/ownprem-mount-/);
    });

    it('falls back to os.tmpdir if /run does not exist', async () => {
      state.runExists = false;

      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'testuser',
          password: 'testpass',
        },
      });

      const mkdtempOp = state.fileOperations.find((op) => op.type === 'mkdtemp');
      expect(mkdtempOp).toBeDefined();
      // Should NOT start with /run when /run doesn't exist
      expect(mkdtempOp!.path).not.toMatch(/^\/run\//);
    });

    it('credentials file is inside the temp directory', async () => {
      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'testuser',
          password: 'testpass',
        },
      });

      const mkdtempOp = state.fileOperations.find((op) => op.type === 'mkdtemp');
      const writeOps = state.fileOperations.filter((op) => op.type === 'write' && op.path.includes('credentials'));

      expect(writeOps.length).toBeGreaterThan(0);
      const credentialWrite = writeOps[0];
      expect(credentialWrite.path).toBe(`${mkdtempOp!.path}/credentials`);
    });
  });

  describe('credentials file has mode 0o400', () => {
    it('writes credentials with mode 0o400 (owner read only)', async () => {
      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'testuser',
          password: 'testpass',
        },
      });

      const credentialWrite = state.fileOperations.find(
        (op) => op.type === 'write' && op.content?.includes('username=')
      );

      expect(credentialWrite).toBeDefined();
      expect(credentialWrite!.mode).toBe(0o400);
    });

    it('overwrite with zeros also uses mode 0o400', async () => {
      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'testuser',
          password: 'testpass',
        },
      });

      const overwriteOp = state.fileOperations.find((op) => op.type === 'write' && op.content?.match(/^0+$/));

      expect(overwriteOp).toBeDefined();
      expect(overwriteOp!.mode).toBe(0o400);
    });
  });

  describe('credentials overwritten before deletion', () => {
    it('overwrites credentials file with zeros before unlinking', async () => {
      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'testuser',
          password: 'testpass',
        },
      });

      const credentialWrite = state.fileOperations.find(
        (op) => op.type === 'write' && op.content?.includes('username=')
      );
      const credFilePath = credentialWrite!.path;

      const overwriteOp = state.fileOperations.find(
        (op) => op.type === 'write' && op.path === credFilePath && op.content?.match(/^0+$/)
      );
      expect(overwriteOp).toBeDefined();
      expect(overwriteOp!.content).toBe('0'.repeat(256));

      const unlinkOp = state.fileOperations.find((op) => op.type === 'unlink' && op.path === credFilePath);
      expect(unlinkOp).toBeDefined();

      // Verify order: overwrite happens before unlink
      const overwriteIndex = state.fileOperations.indexOf(overwriteOp!);
      const unlinkIndex = state.fileOperations.indexOf(unlinkOp!);
      expect(overwriteIndex).toBeLessThan(unlinkIndex);
    });

    it('overwrites with sufficient length to cover typical credentials', async () => {
      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'testuser',
          password: 'testpass',
        },
      });

      const overwriteOp = state.fileOperations.find((op) => op.type === 'write' && op.content?.match(/^0+$/));

      expect(overwriteOp).toBeDefined();
      expect(overwriteOp!.content!.length).toBeGreaterThanOrEqual(256);
    });
  });

  describe('finally block runs on mount failure', () => {
    it('cleans up credentials even when mount command fails', async () => {
      state.spawnSyncBehavior = 'mount-fail';

      await expect(
        mountStorage({
          mountType: 'cifs',
          source: '//server/share',
          mountPoint: '/mnt/share',
          credentials: {
            username: 'testuser',
            password: 'testpass',
          },
        })
      ).rejects.toThrow('Mount failed');

      const overwriteOp = state.fileOperations.find((op) => op.type === 'write' && op.content?.match(/^0+$/));
      const unlinkOp = state.fileOperations.find((op) => op.type === 'unlink' && op.path.includes('credentials'));

      expect(overwriteOp).toBeDefined();
      expect(unlinkOp).toBeDefined();
    });

    it('removes temp directory even when mount fails', async () => {
      state.spawnSyncBehavior = 'mount-fail';

      await expect(
        mountStorage({
          mountType: 'cifs',
          source: '//server/share',
          mountPoint: '/mnt/share',
          credentials: {
            username: 'testuser',
            password: 'testpass',
          },
        })
      ).rejects.toThrow('Mount failed');

      const rmdirOp = state.fileOperations.find((op) => op.type === 'rmdir' && op.path.includes('ownprem-mount-'));
      expect(rmdirOp).toBeDefined();
    });

    it('handles cleanup errors gracefully without throwing', async () => {
      state.unlinkShouldThrow = true;

      // Should not throw even if cleanup fails
      await expect(
        mountStorage({
          mountType: 'cifs',
          source: '//server/share',
          mountPoint: '/mnt/share',
          credentials: {
            username: 'testuser',
            password: 'testpass',
          },
        })
      ).resolves.not.toThrow();
    });

    it('attempts cleanup of both file and directory on failure', async () => {
      state.spawnSyncBehavior = 'mount-fail';

      await expect(
        mountStorage({
          mountType: 'cifs',
          source: '//server/share',
          mountPoint: '/mnt/share',
          credentials: {
            username: 'testuser',
            password: 'testpass',
          },
        })
      ).rejects.toThrow();

      const unlinkOps = state.fileOperations.filter((op) => op.type === 'unlink');
      const rmdirOps = state.fileOperations.filter((op) => op.type === 'rmdir');

      expect(unlinkOps.length).toBeGreaterThan(0);
      expect(rmdirOps.length).toBeGreaterThan(0);
    });
  });

  describe('credentials not logged in error messages', () => {
    it('does not log password in info messages', async () => {
      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'testuser',
          password: 'supersecretpassword123',
        },
      });

      for (const log of state.logMessages) {
        const messageStr = JSON.stringify(log);
        expect(messageStr).not.toContain('supersecretpassword123');
      }
    });

    it('does not log password in error messages when mount fails', async () => {
      state.spawnSyncBehavior = 'mount-fail';

      try {
        await mountStorage({
          mountType: 'cifs',
          source: '//server/share',
          mountPoint: '/mnt/share',
          credentials: {
            username: 'testuser',
            password: 'verysecretpassword456',
          },
        });
      } catch {
        // Expected to fail
      }

      for (const log of state.logMessages) {
        const messageStr = JSON.stringify(log);
        expect(messageStr).not.toContain('verysecretpassword456');
      }
    });

    it('does not log username in plain text', async () => {
      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'sensitiveusername',
          password: 'testpass',
        },
      });

      for (const log of state.logMessages) {
        const messageStr = JSON.stringify(log);
        expect(messageStr).not.toContain('sensitiveusername');
      }
    });

    it('does not include credentials in thrown error', async () => {
      state.spawnSyncBehavior = 'mount-fail';

      let errorMessage = '';
      try {
        await mountStorage({
          mountType: 'cifs',
          source: '//server/share',
          mountPoint: '/mnt/share',
          credentials: {
            username: 'secretuser',
            password: 'secretpass789',
          },
        });
      } catch (err) {
        errorMessage = (err as Error).message;
      }

      expect(errorMessage).not.toContain('secretuser');
      expect(errorMessage).not.toContain('secretpass789');
    });
  });

  describe('credential content format', () => {
    it('writes credentials in correct format for CIFS', async () => {
      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'myuser',
          password: 'mypass',
        },
      });

      const credentialWrite = state.fileOperations.find(
        (op) => op.type === 'write' && op.content?.includes('username=')
      );

      expect(credentialWrite).toBeDefined();
      expect(credentialWrite!.content).toContain('username=myuser');
      expect(credentialWrite!.content).toContain('password=mypass');
    });

    it('includes domain when provided', async () => {
      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'myuser',
          password: 'mypass',
          domain: 'MYDOMAIN',
        },
      });

      const credentialWrite = state.fileOperations.find(
        (op) => op.type === 'write' && op.content?.includes('username=')
      );

      expect(credentialWrite!.content).toContain('domain=MYDOMAIN');
    });

    it('does not create credentials file for NFS mounts', async () => {
      await mountStorage({
        mountType: 'nfs',
        source: 'nfsserver:/export/share',
        mountPoint: '/mnt/nfs',
      });

      const credentialWrites = state.fileOperations.filter(
        (op) => op.type === 'write' && op.path.includes('credentials')
      );

      expect(credentialWrites.length).toBe(0);
    });

    it('does not create credentials file for CIFS without credentials', async () => {
      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
      });

      const credentialWrites = state.fileOperations.filter(
        (op) => op.type === 'write' && op.path.includes('credentials')
      );

      expect(credentialWrites.length).toBe(0);
    });
  });

  describe('mount command construction', () => {
    it('passes credentials file path to mount command', async () => {
      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'testuser',
          password: 'testpass',
        },
      });

      const mountCall = spawnSyncCalls.find((call) => call[0] === 'mount');

      expect(mountCall).toBeDefined();
      const args = mountCall![1] as string[];

      const optIndex = args.indexOf('-o');
      expect(optIndex).toBeGreaterThan(-1);
      const options = args[optIndex + 1];
      expect(options).toMatch(/credentials=\/run\/ownprem-mount-\d+\/credentials/);
    });

    it('does not pass credentials directly on command line', async () => {
      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'testuser',
          password: 'testpass',
        },
      });

      const mountCall = spawnSyncCalls.find((call) => call[0] === 'mount');

      expect(mountCall).toBeDefined();
      const argsStr = JSON.stringify(mountCall![1]);

      // Password should not appear in command args
      expect(argsStr).not.toContain('testpass');
      expect(argsStr).not.toContain('password=');
    });
  });

  describe('already mounted handling', () => {
    it('skips mount and cleanup if already mounted', async () => {
      state.spawnSyncBehavior = 'already-mounted';

      await mountStorage({
        mountType: 'cifs',
        source: '//server/share',
        mountPoint: '/mnt/share',
        credentials: {
          username: 'testuser',
          password: 'testpass',
        },
      });

      const credentialWrites = state.fileOperations.filter(
        (op) => op.type === 'write' && op.content?.includes('username=')
      );

      expect(credentialWrites.length).toBe(0);
    });
  });
});
