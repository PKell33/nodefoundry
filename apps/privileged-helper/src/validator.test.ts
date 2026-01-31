/**
 * Privileged Helper - Validator Tests
 *
 * Tests for the security-critical validation layer that prevents:
 * - Path traversal attacks
 * - Symlink escape attacks
 * - Service name pattern bypass
 * - Unauthorized file writes
 * - Mount injection attacks
 * - Command injection via arguments
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { HelperRequest } from './types.js';

// Mock fs module before importing validator
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    lstatSync: vi.fn(),
    realpathSync: vi.fn(),
  };
});

// Import after mocking
const { validateRequest, ValidationError } = await import('./validator.js');
const fs = await import('fs');

// Helper to create mock fs functions
function mockFs(config: {
  exists?: Record<string, boolean>;
  symlinks?: Record<string, boolean>;
  realPaths?: Record<string, string>;
}) {
  const { exists = {}, symlinks = {}, realPaths = {} } = config;

  vi.mocked(fs.existsSync).mockImplementation((path) => {
    const p = String(path);
    return exists[p] ?? false;
  });

  vi.mocked(fs.lstatSync).mockImplementation((path) => {
    const p = String(path);
    if (!exists[p]) {
      throw new Error(`ENOENT: no such file or directory, lstat '${p}'`);
    }
    return {
      isSymbolicLink: () => symlinks[p] ?? false,
      isFile: () => !symlinks[p],
      isDirectory: () => false,
    } as any;
  });

  vi.mocked(fs.realpathSync).mockImplementation((path) => {
    const p = String(path);
    if (!exists[p]) {
      throw new Error(`ENOENT: no such file or directory, realpath '${p}'`);
    }
    return realPaths[p] ?? p;
  });
}

describe('Validator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: paths don't exist (creating new files/dirs)
    mockFs({ exists: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic Request Validation', () => {
    it('should reject null request', () => {
      expect(() => validateRequest(null as any)).toThrow(ValidationError);
      expect(() => validateRequest(null as any)).toThrow('Invalid request format');
    });

    it('should reject non-object request', () => {
      expect(() => validateRequest('string' as any)).toThrow(ValidationError);
      expect(() => validateRequest(123 as any)).toThrow(ValidationError);
    });

    it('should reject unknown action', () => {
      expect(() => validateRequest({ action: 'unknown_action' } as any)).toThrow(ValidationError);
      expect(() => validateRequest({ action: 'unknown_action' } as any)).toThrow('Unknown action');
    });
  });

  describe('Path Traversal Prevention', () => {
    describe('create_directory', () => {
      it('should reject explicit path traversal with ..', () => {
        const request: HelperRequest = {
          action: 'create_directory',
          path: '/var/lib/../../../etc/passwd',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
        expect(() => validateRequest(request)).toThrow('not allowed');
      });

      it('should reject path traversal in middle of path', () => {
        const request: HelperRequest = {
          action: 'create_directory',
          path: '/var/lib/ownprem/../../../etc/cron.d',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
      });

      it('should reject null bytes in path', () => {
        const request: HelperRequest = {
          action: 'create_directory',
          path: '/var/lib/ownprem\x00/etc/passwd',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
      });

      it('should reject paths outside allowed prefixes', () => {
        const request: HelperRequest = {
          action: 'create_directory',
          path: '/tmp/malicious',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
        expect(() => validateRequest(request)).toThrow('not allowed');
      });

      it('should allow valid paths within allowed prefixes', () => {
        mockFs({
          exists: { '/var/lib': true },
          realPaths: { '/var/lib': '/var/lib' },
        });

        const request: HelperRequest = {
          action: 'create_directory',
          path: '/var/lib/myapp/data',
        };

        expect(() => validateRequest(request)).not.toThrow();
      });
    });

    describe('write_file', () => {
      it('should reject path traversal in write paths', () => {
        const request: HelperRequest = {
          action: 'write_file',
          path: '/etc/systemd/system/ownprem-../../../cron.d/evil.service',
          content: 'malicious content',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
      });

      it('should reject null bytes in write paths', () => {
        const request: HelperRequest = {
          action: 'write_file',
          path: '/etc/systemd/system/ownprem-app\x00.service',
          content: 'content',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
      });

      it('should reject write paths not matching prefix/suffix rules', () => {
        const request: HelperRequest = {
          action: 'write_file',
          path: '/etc/systemd/system/not-ownprem.service',
          content: 'content',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
        expect(() => validateRequest(request)).toThrow('not allowed');
      });

      it('should reject systemd files without .service suffix', () => {
        const request: HelperRequest = {
          action: 'write_file',
          path: '/etc/systemd/system/ownprem-app.timer',
          content: 'content',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
      });

      it('should allow valid systemd service files', () => {
        mockFs({
          exists: { '/etc/systemd/system': true },
          realPaths: { '/etc/systemd/system': '/etc/systemd/system' },
        });

        const request: HelperRequest = {
          action: 'write_file',
          path: '/etc/systemd/system/ownprem-myapp.service',
          content: '[Unit]\nDescription=My App',
        };

        expect(() => validateRequest(request)).not.toThrow();
      });

      it('should allow writes to /opt/ownprem/apps/', () => {
        mockFs({
          exists: { '/opt/ownprem/apps': true },
          realPaths: { '/opt/ownprem/apps': '/opt/ownprem/apps' },
        });

        const request: HelperRequest = {
          action: 'write_file',
          path: '/opt/ownprem/apps/myapp/config.json',
          content: '{}',
        };

        expect(() => validateRequest(request)).not.toThrow();
      });
    });
  });

  describe('Symlink Escape Prevention', () => {
    it('should reject symlink pointing outside allowed directories', () => {
      mockFs({
        exists: {
          '/var/lib/malicious': true,
        },
        symlinks: {
          '/var/lib/malicious': true,
        },
        realPaths: {
          '/var/lib/malicious': '/etc/shadow',
        },
      });

      const request: HelperRequest = {
        action: 'create_directory',
        path: '/var/lib/malicious',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
    });

    it('should reject path through symlink parent that escapes to disallowed area', () => {
      // When an existing directory is a symlink pointing to a completely disallowed area
      // (not a parent of any allowed path), the request should be rejected.
      // Here: /var/lib/escape is a symlink to /tmp (not allowed at all)
      mockFs({
        exists: {
          '/var/lib/escape': true,
          '/var/lib': true,
        },
        symlinks: {
          '/var/lib/escape': true,
          '/var/lib': false,
        },
        realPaths: {
          '/var/lib/escape': '/tmp',
          '/var/lib': '/var/lib',
        },
      });

      const request: HelperRequest = {
        action: 'create_directory',
        path: '/var/lib/escape/malicious',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
    });

    it('should allow symlinks within allowed directories', () => {
      mockFs({
        exists: {
          '/var/lib/symlink': true,
        },
        symlinks: {
          '/var/lib/symlink': true,
        },
        realPaths: {
          '/var/lib/symlink': '/var/lib/actual-dir',
        },
      });

      const request: HelperRequest = {
        action: 'create_directory',
        path: '/var/lib/symlink',
      };

      expect(() => validateRequest(request)).not.toThrow();
    });

    it('should reject write_file through symlink escaping to /etc', () => {
      mockFs({
        exists: {
          '/opt/ownprem/apps/evil': true,
        },
        symlinks: {
          '/opt/ownprem/apps/evil': true,
        },
        realPaths: {
          '/opt/ownprem/apps/evil': '/etc/cron.d',
        },
      });

      const request: HelperRequest = {
        action: 'write_file',
        path: '/opt/ownprem/apps/evil/backdoor',
        content: '* * * * * root /tmp/evil.sh',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
    });
  });

  describe('Service Name Validation', () => {
    it('should reject service names not matching allowed patterns', () => {
      mockFs({
        exists: { '/var/lib/ownprem/services/evil-service': true },
        realPaths: { '/var/lib/ownprem/services/evil-service': '/var/lib/ownprem/services/evil-service' },
      });

      const request: HelperRequest = {
        action: 'systemctl',
        operation: 'start',
        service: 'evil-service',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Service not allowed');
    });

    it('should reject ownprem- services with uppercase letters', () => {
      const request: HelperRequest = {
        action: 'systemctl',
        operation: 'start',
        service: 'ownprem-MyApp',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Service not allowed');
    });

    it('should reject ownprem- services that are not registered', () => {
      mockFs({
        exists: { '/var/lib/ownprem/services/ownprem-unregistered': false },
      });

      const request: HelperRequest = {
        action: 'systemctl',
        operation: 'start',
        service: 'ownprem-unregistered',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Service not registered');
    });

    it('should reject service registration file that is a symlink', () => {
      mockFs({
        exists: {
          '/var/lib/ownprem/services/ownprem-symlink-attack': true,
        },
        symlinks: {
          '/var/lib/ownprem/services/ownprem-symlink-attack': true,
        },
      });

      const request: HelperRequest = {
        action: 'systemctl',
        operation: 'start',
        service: 'ownprem-symlink-attack',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('not registered');
    });

    it('should allow registered ownprem- services', () => {
      mockFs({
        exists: {
          '/var/lib/ownprem/services/ownprem-myapp': true,
        },
        symlinks: {
          '/var/lib/ownprem/services/ownprem-myapp': false,
        },
      });

      const request: HelperRequest = {
        action: 'systemctl',
        operation: 'start',
        service: 'ownprem-myapp',
      };

      expect(() => validateRequest(request)).not.toThrow();
    });

    it('should allow system services without registration', () => {
      const request: HelperRequest = {
        action: 'systemctl',
        operation: 'restart',
        service: 'caddy',
      };

      expect(() => validateRequest(request)).not.toThrow();
    });

    it('should allow daemon-reload without service name', () => {
      const request: HelperRequest = {
        action: 'systemctl',
        operation: 'daemon-reload',
      };

      expect(() => validateRequest(request)).not.toThrow();
    });

    it('should reject invalid systemctl operations', () => {
      const request: HelperRequest = {
        action: 'systemctl',
        operation: 'kill' as any,
        service: 'caddy',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Invalid systemctl operation');
    });
  });

  describe('Service Registration', () => {
    it('should reject registering system services', () => {
      const request: HelperRequest = {
        action: 'register_service',
        serviceName: 'ownprem-orchestrator',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Cannot register system service');
    });

    it('should reject unregistering system services', () => {
      const request: HelperRequest = {
        action: 'unregister_service',
        serviceName: 'caddy',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Cannot unregister system service');
    });

    it('should reject invalid service name patterns for registration', () => {
      const request: HelperRequest = {
        action: 'register_service',
        serviceName: 'not-ownprem-prefix',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Invalid service name pattern');
    });

    it('should allow registering valid ownprem- services', () => {
      const request: HelperRequest = {
        action: 'register_service',
        serviceName: 'ownprem-myapp',
      };

      expect(() => validateRequest(request)).not.toThrow();
    });
  });

  describe('Create Service User Validation', () => {
    it('should reject invalid username format', () => {
      const request: HelperRequest = {
        action: 'create_service_user',
        username: 'Invalid-User-123',
        homeDir: '/var/lib/myapp',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Invalid username format');
    });

    it('should reject username starting with number', () => {
      const request: HelperRequest = {
        action: 'create_service_user',
        username: '123user',
        homeDir: '/var/lib/myapp',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
    });

    it('should reject home directory outside allowed prefixes', () => {
      const request: HelperRequest = {
        action: 'create_service_user',
        username: 'myapp',
        homeDir: '/home/myapp',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Home directory not allowed');
    });

    it('should reject path traversal in home directory', () => {
      const request: HelperRequest = {
        action: 'create_service_user',
        username: 'myapp',
        homeDir: '/var/lib/../../../etc',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Path traversal not allowed');
    });

    it('should allow valid service user creation', () => {
      const request: HelperRequest = {
        action: 'create_service_user',
        username: 'myapp',
        homeDir: '/var/lib/myapp',
      };

      expect(() => validateRequest(request)).not.toThrow();
    });

    it('should allow system users from explicit list', () => {
      const request: HelperRequest = {
        action: 'create_service_user',
        username: 'caddy',
        homeDir: '/var/lib/caddy',
      };

      expect(() => validateRequest(request)).not.toThrow();
    });
  });

  describe('Owner and Mode Format Validation', () => {
    it('should reject invalid owner format with special chars', () => {
      mockFs({
        exists: { '/var/lib': true },
        realPaths: { '/var/lib': '/var/lib' },
      });

      const request: HelperRequest = {
        action: 'create_directory',
        path: '/var/lib/test',
        owner: 'user; rm -rf /',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Invalid owner format');
    });

    it('should reject invalid mode format', () => {
      mockFs({
        exists: { '/var/lib': true },
        realPaths: { '/var/lib': '/var/lib' },
      });

      const request: HelperRequest = {
        action: 'create_directory',
        path: '/var/lib/test',
        mode: '999',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Invalid mode format');
    });

    it('should reject mode with non-octal digits', () => {
      mockFs({
        exists: { '/var/lib': true },
        realPaths: { '/var/lib': '/var/lib' },
      });

      const request: HelperRequest = {
        action: 'set_permissions',
        path: '/var/lib/test',
        mode: '789',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
    });

    it('should allow valid user:group owner format', () => {
      mockFs({
        exists: { '/var/lib': true },
        realPaths: { '/var/lib': '/var/lib' },
      });

      const request: HelperRequest = {
        action: 'create_directory',
        path: '/var/lib/test',
        owner: 'myapp:myapp',
        mode: '0755',
      };

      expect(() => validateRequest(request)).not.toThrow();
    });
  });

  describe('Capability Validation', () => {
    it('should reject binary paths outside allowed directories', () => {
      const request: HelperRequest = {
        action: 'set_capability',
        path: '/usr/bin/evil',
        capability: 'cap_net_bind_service=+ep',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Binary path not allowed');
    });

    it('should reject disallowed capabilities', () => {
      const request: HelperRequest = {
        action: 'set_capability',
        path: '/opt/ownprem/apps/myapp/bin/server',
        capability: 'cap_sys_admin=+ep',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Capability not allowed');
    });

    it('should reject path traversal in capability binary path', () => {
      const request: HelperRequest = {
        action: 'set_capability',
        path: '/opt/ownprem/apps/../../../usr/bin/evil',
        capability: 'cap_net_bind_service=+ep',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
    });

    it('should allow valid capability on app binaries', () => {
      const request: HelperRequest = {
        action: 'set_capability',
        path: '/opt/ownprem/apps/myapp/bin/server',
        capability: 'cap_net_bind_service=+ep',
      };

      expect(() => validateRequest(request)).not.toThrow();
    });
  });

  describe('Run As User Validation', () => {
    it('should reject disallowed users', () => {
      const request: HelperRequest = {
        action: 'run_as_user',
        user: 'root',
        command: '/bin/bash',
        args: [],
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('User not allowed for run_as_user');
    });

    it('should reject disallowed commands', () => {
      const request: HelperRequest = {
        action: 'run_as_user',
        user: 'step-ca',
        command: '/bin/bash',
        args: ['-c', 'evil command'],
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Command not allowed');
    });

    it('should reject null bytes in arguments', () => {
      const request: HelperRequest = {
        action: 'run_as_user',
        user: 'step-ca',
        command: '/opt/ownprem/apps/ownprem-ca/bin/step',
        args: ['arg\x00evil'],
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Null bytes not allowed');
    });

    it('should reject newlines in arguments', () => {
      const request: HelperRequest = {
        action: 'run_as_user',
        user: 'step-ca',
        command: '/opt/ownprem/apps/ownprem-ca/bin/step',
        args: ['arg\nevil'],
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Newlines not allowed');
    });

    it('should reject shell metacharacters in arguments', () => {
      const request: HelperRequest = {
        action: 'run_as_user',
        user: 'step-ca',
        command: '/opt/ownprem/apps/ownprem-ca/bin/step',
        args: ['$(rm -rf /)'],
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Invalid characters in argument');
    });

    it('should reject backticks in arguments', () => {
      const request: HelperRequest = {
        action: 'run_as_user',
        user: 'step-ca',
        command: '/opt/ownprem/apps/ownprem-ca/bin/step',
        args: ['`whoami`'],
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
    });

    it('should reject semicolons in arguments', () => {
      const request: HelperRequest = {
        action: 'run_as_user',
        user: 'step-ca',
        command: '/opt/ownprem/apps/ownprem-ca/bin/step',
        args: ['arg; rm -rf /'],
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
    });

    it('should reject disallowed cwd', () => {
      mockFs({
        exists: { '/tmp': true },
        realPaths: { '/tmp': '/tmp' },
      });

      const request: HelperRequest = {
        action: 'run_as_user',
        user: 'step-ca',
        command: '/opt/ownprem/apps/ownprem-ca/bin/step',
        args: ['version'],
        cwd: '/tmp',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Working directory not allowed');
    });

    it('should allow valid command with safe arguments', () => {
      const request: HelperRequest = {
        action: 'run_as_user',
        user: 'step-ca',
        command: '/opt/ownprem/apps/ownprem-ca/bin/step',
        args: ['certificate', 'create', '--profile=leaf', 'test.local'],
      };

      expect(() => validateRequest(request)).not.toThrow();
    });
  });

  describe('Mount Validation', () => {
    describe('Mount type', () => {
      it('should reject invalid mount type', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'ext4' as any,
          source: '/dev/sda1',
          mountPoint: '/mnt/data',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
        expect(() => validateRequest(request)).toThrow('Invalid mount type');
      });
    });

    describe('Mount point', () => {
      it('should reject path traversal in mount point', () => {
        // Path with .. is rejected by MOUNT_POINT_PATTERN which only allows [a-zA-Z0-9/_-]
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'nfs',
          source: 'server:/share',
          mountPoint: '/mnt/../etc/passwd',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
        expect(() => validateRequest(request)).toThrow('Invalid mount point format');
      });

      it('should reject mount point outside allowed prefixes', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'nfs',
          source: 'server:/share',
          mountPoint: '/home/user/data',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
        expect(() => validateRequest(request)).toThrow('not in allowed prefix');
      });

      it('should reject mount point with invalid characters', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'nfs',
          source: 'server:/share',
          mountPoint: '/mnt/data$(evil)',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
        expect(() => validateRequest(request)).toThrow('Invalid mount point format');
      });
    });

    describe('NFS source', () => {
      it('should reject invalid NFS source format', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'nfs',
          source: 'invalid-source',
          mountPoint: '/mnt/data',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
        expect(() => validateRequest(request)).toThrow('Invalid NFS source format');
      });

      it('should reject NFS source with shell injection', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'nfs',
          source: 'server$(evil):/share',
          mountPoint: '/mnt/data',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
      });

      it('should allow valid NFS source', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'nfs',
          source: 'nas.local:/exports/data',
          mountPoint: '/mnt/data',
        };

        expect(() => validateRequest(request)).not.toThrow();
      });
    });

    describe('CIFS source', () => {
      it('should reject invalid CIFS source format', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'cifs',
          source: 'invalid-source',
          mountPoint: '/mnt/data',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
        expect(() => validateRequest(request)).toThrow('Invalid CIFS source format');
      });

      it('should allow valid CIFS source', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'cifs',
          source: '//fileserver/share',
          mountPoint: '/mnt/data',
        };

        expect(() => validateRequest(request)).not.toThrow();
      });
    });

    describe('Mount options', () => {
      it('should reject invalid mount options', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'nfs',
          source: 'server:/share',
          mountPoint: '/mnt/data',
          options: 'rw,exec,suid',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
        expect(() => validateRequest(request)).toThrow('Invalid mount option');
      });

      it('should reject mount options with command injection', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'nfs',
          source: 'server:/share',
          mountPoint: '/mnt/data',
          options: 'rw,$(evil)',
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
      });

      it('should allow valid mount options', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'nfs',
          source: 'server:/share',
          mountPoint: '/mnt/data',
          options: 'vers=4,rw,noatime,rsize=8192',
        };

        expect(() => validateRequest(request)).not.toThrow();
      });
    });

    describe('CIFS credentials', () => {
      it('should reject missing password in credentials', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'cifs',
          source: '//server/share',
          mountPoint: '/mnt/data',
          credentials: {
            username: 'user',
            password: '',
          },
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
        expect(() => validateRequest(request)).toThrow('require username and password');
      });

      it('should reject invalid characters in username', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'cifs',
          source: '//server/share',
          mountPoint: '/mnt/data',
          credentials: {
            username: 'user$(evil)',
            password: 'password',
          },
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
        expect(() => validateRequest(request)).toThrow('Invalid characters in CIFS username');
      });

      it('should reject invalid characters in domain', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'cifs',
          source: '//server/share',
          mountPoint: '/mnt/data',
          credentials: {
            username: 'user',
            password: 'password',
            domain: 'DOMAIN$(evil)',
          },
        };

        expect(() => validateRequest(request)).toThrow(ValidationError);
        expect(() => validateRequest(request)).toThrow('Invalid characters in CIFS domain');
      });

      it('should allow valid CIFS credentials', () => {
        const request: HelperRequest = {
          action: 'mount',
          mountType: 'cifs',
          source: '//server/share',
          mountPoint: '/mnt/data',
          credentials: {
            username: 'admin@company.com',
            password: 'P@ssw0rd!#$%',
            domain: 'CORP.COMPANY.COM',
          },
        };

        expect(() => validateRequest(request)).not.toThrow();
      });
    });
  });

  describe('Umount Validation', () => {
    it('should reject path traversal in umount', () => {
      // Path with .. is rejected by MOUNT_POINT_PATTERN which only allows [a-zA-Z0-9/_-]
      const request: HelperRequest = {
        action: 'umount',
        mountPoint: '/mnt/../etc',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Invalid mount point format');
    });

    it('should reject umount outside allowed prefixes', () => {
      const request: HelperRequest = {
        action: 'umount',
        mountPoint: '/tmp/mount',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('not in allowed prefix');
    });

    it('should allow valid umount', () => {
      const request: HelperRequest = {
        action: 'umount',
        mountPoint: '/mnt/data',
      };

      expect(() => validateRequest(request)).not.toThrow();
    });
  });

  describe('APT Install Validation', () => {
    it('should reject packages not in whitelist', () => {
      const request: HelperRequest = {
        action: 'apt_install',
        packages: ['curl'],
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('not in allowlist');
    });

    it('should reject empty packages array', () => {
      const request: HelperRequest = {
        action: 'apt_install',
        packages: [],
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('non-empty array');
    });

    it('should reject if any package is not in whitelist', () => {
      const request: HelperRequest = {
        action: 'apt_install',
        packages: ['nfs-common', 'wget'],
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('not in allowlist');
    });

    it('should allow whitelisted packages', () => {
      const request: HelperRequest = {
        action: 'apt_install',
        packages: ['nfs-common', 'cifs-utils'],
      };

      expect(() => validateRequest(request)).not.toThrow();
    });
  });

  describe('Copy File Validation', () => {
    it('should reject source outside allowed paths', () => {
      mockFs({
        exists: { '/etc/passwd': true },
        realPaths: { '/etc/passwd': '/etc/passwd' },
      });

      const request: HelperRequest = {
        action: 'copy_file',
        source: '/etc/passwd',
        destination: '/opt/ownprem/apps/myapp/passwd',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Source path not allowed');
    });

    it('should reject destination outside allowed write paths', () => {
      mockFs({
        exists: { '/var/lib': true },
        realPaths: { '/var/lib': '/var/lib' },
      });

      const request: HelperRequest = {
        action: 'copy_file',
        source: '/var/lib/myapp/file.txt',
        destination: '/etc/cron.d/evil',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Destination path not allowed');
    });

    it('should allow valid copy within allowed paths', () => {
      mockFs({
        exists: {
          '/var/lib/myapp': true,
          '/opt/ownprem/apps': true,
        },
        realPaths: {
          '/var/lib/myapp': '/var/lib/myapp',
          '/opt/ownprem/apps': '/opt/ownprem/apps',
        },
      });

      const request: HelperRequest = {
        action: 'copy_file',
        source: '/var/lib/myapp/config.json',
        destination: '/opt/ownprem/apps/myapp/config.json',
      };

      expect(() => validateRequest(request)).not.toThrow();
    });
  });

  describe('Set Ownership Validation', () => {
    it('should reject path outside allowed prefixes', () => {
      const request: HelperRequest = {
        action: 'set_ownership',
        path: '/etc/passwd',
        owner: 'root',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
    });

    it('should reject invalid owner format', () => {
      mockFs({
        exists: { '/var/lib': true },
        realPaths: { '/var/lib': '/var/lib' },
      });

      const request: HelperRequest = {
        action: 'set_ownership',
        path: '/var/lib/myapp',
        owner: 'root; chmod 777 /',
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Invalid owner format');
    });
  });

  describe('Edge Cases', () => {
    it('should handle multiple slashes in path', () => {
      mockFs({
        exists: { '/var/lib': true },
        realPaths: { '/var/lib': '/var/lib' },
      });

      const request: HelperRequest = {
        action: 'create_directory',
        path: '/var/lib///myapp//data/',
      };

      expect(() => validateRequest(request)).not.toThrow();
    });

    it('should handle trailing slashes', () => {
      mockFs({
        exists: { '/var/lib': true },
        realPaths: { '/var/lib': '/var/lib' },
      });

      const request: HelperRequest = {
        action: 'create_directory',
        path: '/var/lib/myapp/',
      };

      expect(() => validateRequest(request)).not.toThrow();
    });

    it('should reject write_file with non-string content', () => {
      const request: HelperRequest = {
        action: 'write_file',
        path: '/opt/ownprem/apps/myapp/config',
        content: { evil: 'object' } as any,
      };

      expect(() => validateRequest(request)).toThrow(ValidationError);
      expect(() => validateRequest(request)).toThrow('Content must be a string');
    });
  });
});
