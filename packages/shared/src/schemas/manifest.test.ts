import { describe, it, expect } from 'vitest';
import {
  AppManifestSchema,
  LoggingSchema,
  DataDirectorySchema,
  AppSourceSchema,
  VALID_LINUX_CAPABILITIES,
} from './manifest.js';

describe('AppManifestSchema Security Validations', () => {
  describe('P0: serviceName validation', () => {
    it('accepts valid service names with ownprem- prefix', () => {
      const validNames = [
        'ownprem-app',
        'ownprem-my-app',
        'ownprem-app123',
        'ownprem-mock-app',
        'ownprem-bitcoin-core',
      ];

      for (const serviceName of validNames) {
        const result = LoggingSchema.safeParse({ serviceName });
        expect(result.success, `Expected ${serviceName} to be valid`).toBe(true);
      }
    });

    it('rejects service names without ownprem- prefix', () => {
      const invalidNames = [
        'my-app',
        'bitcoin',
        'app-ownprem',
      ];

      for (const serviceName of invalidNames) {
        const result = LoggingSchema.safeParse({ serviceName });
        expect(result.success, `Expected ${serviceName} to be rejected`).toBe(false);
      }
    });

    it('rejects path traversal attempts in serviceName', () => {
      const maliciousNames = [
        '../../../etc/passwd',
        'ownprem-app/../../../etc',
        'ownprem-app/../../etc/passwd',
        '..\\..\\windows\\system32',
      ];

      for (const serviceName of maliciousNames) {
        const result = LoggingSchema.safeParse({ serviceName });
        expect(result.success, `Expected ${serviceName} to be rejected`).toBe(false);
      }
    });

    it('rejects service names with invalid characters', () => {
      const invalidNames = [
        'ownprem-app;rm -rf /',
        'ownprem-app$(whoami)',
        'ownprem-app`id`',
        'ownprem-APP',  // uppercase not allowed
        'ownprem-app name',  // spaces not allowed
      ];

      for (const serviceName of invalidNames) {
        const result = LoggingSchema.safeParse({ serviceName });
        expect(result.success, `Expected ${serviceName} to be rejected`).toBe(false);
      }
    });

    it('rejects service names that are too long', () => {
      const longName = 'ownprem-' + 'a'.repeat(60);  // 68 chars, exceeds 64
      const result = LoggingSchema.safeParse({ serviceName: longName });
      expect(result.success).toBe(false);
    });
  });

  describe('P0: capabilities validation', () => {
    it('accepts valid Linux capabilities in setcap format', () => {
      const manifest = createMinimalManifest({
        capabilities: ['cap_net_bind_service=+ep', 'cap_net_raw=+ep'],
      });
      const result = AppManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
    });

    it('rejects invalid capability strings', () => {
      const invalidCapabilities = [
        'cat /etc/passwd',
        'CAP_NET_BIND_SERVICE',  // wrong format - should be lowercase with =+ep
        'rm -rf /',
        "'; DROP TABLE users; --",
        'cap_net_bind_service',  // missing =+ep suffix
        'cap_invalid=+ep',  // not in whitelist
      ];

      for (const cap of invalidCapabilities) {
        const manifest = createMinimalManifest({
          capabilities: [cap],
        });
        const result = AppManifestSchema.safeParse(manifest);
        expect(result.success, `Expected capability "${cap}" to be rejected`).toBe(false);
      }
    });

    it('exports VALID_LINUX_CAPABILITIES for reference', () => {
      expect(VALID_LINUX_CAPABILITIES).toContain('cap_net_bind_service=+ep');
      expect(VALID_LINUX_CAPABILITIES).toContain('cap_sys_admin=+ep');
      expect(Array.isArray(VALID_LINUX_CAPABILITIES)).toBe(true);
    });
  });

  describe('P1: dataDirectories path validation', () => {
    it('accepts valid absolute paths', () => {
      const validPaths = [
        '/var/lib/myapp',
        '/opt/ownprem/data',
        '/data/app',
        '/home/user/.local/share/app',  // .local is allowed
      ];

      for (const path of validPaths) {
        const result = DataDirectorySchema.safeParse({ path });
        expect(result.success, `Expected ${path} to be valid`).toBe(true);
      }
    });

    it('rejects paths with path traversal sequences', () => {
      const maliciousPaths = [
        '/var/lib/../../../etc/passwd',
        '/data/../../../etc',
        '/opt/app/../../..',
      ];

      for (const path of maliciousPaths) {
        const result = DataDirectorySchema.safeParse({ path });
        expect(result.success, `Expected ${path} to be rejected`).toBe(false);
      }
    });

    it('rejects relative paths', () => {
      const relativePaths = [
        'var/lib/app',
        './data',
        '../etc',
      ];

      for (const path of relativePaths) {
        const result = DataDirectorySchema.safeParse({ path });
        expect(result.success, `Expected relative path ${path} to be rejected`).toBe(false);
      }
    });

    it('rejects paths with null bytes', () => {
      const result = DataDirectorySchema.safeParse({ path: '/var/lib/app\0/evil' });
      expect(result.success).toBe(false);
    });

    it('rejects hidden directories except .local', () => {
      const hiddenPaths = [
        '/var/lib/.hidden',
        '/opt/.secret/data',
      ];

      for (const path of hiddenPaths) {
        const result = DataDirectorySchema.safeParse({ path });
        expect(result.success, `Expected hidden path ${path} to be rejected`).toBe(false);
      }
    });
  });

  describe('P1: downloadUrl and checksumUrl validation', () => {
    it('accepts valid HTTPS URLs', () => {
      const source = {
        type: 'binary' as const,
        downloadUrl: 'https://example.com/app.tar.gz',
        checksumUrl: 'https://example.com/app.tar.gz.sha256',
      };
      const result = AppSourceSchema.safeParse(source);
      expect(result.success).toBe(true);
    });

    it('rejects HTTP URLs (requires HTTPS)', () => {
      const source = {
        type: 'binary' as const,
        downloadUrl: 'http://example.com/app.tar.gz',
      };
      const result = AppSourceSchema.safeParse(source);
      expect(result.success).toBe(false);
    });

    it('rejects invalid URLs', () => {
      const invalidUrls = [
        'not-a-url',
        'file:///etc/passwd',
        'ftp://example.com/file',
      ];

      for (const url of invalidUrls) {
        const source = {
          type: 'binary' as const,
          downloadUrl: url,
        };
        const result = AppSourceSchema.safeParse(source);
        expect(result.success, `Expected ${url} to be rejected`).toBe(false);
      }
    });
  });

  describe('logFile path validation', () => {
    it('rejects log file paths with path traversal', () => {
      const result = LoggingSchema.safeParse({
        logFile: '/var/log/../../../etc/passwd',
      });
      expect(result.success).toBe(false);
    });

    it('accepts valid log file paths', () => {
      const result = LoggingSchema.safeParse({
        logFile: '/var/log/myapp/app.log',
      });
      expect(result.success).toBe(true);
    });
  });
});

// Helper to create minimal valid manifest for testing specific fields
function createMinimalManifest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'test-app',
    displayName: 'Test App',
    description: 'A test application',
    version: '1.0.0',
    category: 'utility',
    source: {
      type: 'binary',
    },
    configSchema: [],
    ...overrides,
  };
}
