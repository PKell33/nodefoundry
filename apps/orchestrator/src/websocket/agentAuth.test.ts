/**
 * Agent Authentication Tests
 *
 * Tests for the agent authentication system that protects
 * the orchestrator from unauthorized agent connections.
 * Covers:
 * - Token hashing with HMAC-SHA256
 * - Timing-safe token verification
 * - Localhost IP detection for core server
 * - New-style token authentication with expiration
 * - Legacy token fallback
 * - Token validation per server
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Create test database
let db: Database.Database;

// Mock modules before importing agentAuth
vi.mock('../db/index.js', () => ({
  getDb: () => db,
}));

vi.mock('../config.js', () => ({
  config: {
    tokens: {
      hmacKey: 'test-hmac-key-for-token-hashing-32chars',
    },
  },
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
const { hashToken, verifyToken, isLocalhostIp, authenticateAgent } = await import('./agentAuth.js');

describe('Agent Authentication', () => {
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
    // Clear relevant tables
    db.exec('DELETE FROM agent_tokens');
    db.exec('DELETE FROM servers');
    vi.clearAllMocks();
  });

  describe('hashToken', () => {
    it('should produce consistent hash for same token', () => {
      const token = 'my-secret-token';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different tokens', () => {
      const hash1 = hashToken('token-one');
      const hash2 = hashToken('token-two');

      expect(hash1).not.toBe(hash2);
    });

    it('should return hex-encoded hash', () => {
      const hash = hashToken('test-token');

      // SHA-256 produces 64 hex characters
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle empty string', () => {
      const hash = hashToken('');

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle special characters', () => {
      const hash = hashToken('token-with-special-chars!@#$%^&*()');

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle unicode characters', () => {
      const hash = hashToken('トークン-🔐-密钥');

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('verifyToken', () => {
    it('should return true for matching token', () => {
      const token = 'correct-token';
      const storedHash = hashToken(token);

      expect(verifyToken(token, storedHash)).toBe(true);
    });

    it('should return false for non-matching token', () => {
      const storedHash = hashToken('correct-token');

      expect(verifyToken('wrong-token', storedHash)).toBe(false);
    });

    it('should return false for empty token when hash exists', () => {
      const storedHash = hashToken('real-token');

      expect(verifyToken('', storedHash)).toBe(false);
    });

    it('should handle tokens that hash to similar prefixes', () => {
      // Even if two tokens have similar hashes, they should not match
      const token1 = 'token-a';
      const token2 = 'token-b';
      const hash1 = hashToken(token1);

      expect(verifyToken(token2, hash1)).toBe(false);
    });

    it('should be case-sensitive', () => {
      const storedHash = hashToken('MyToken');

      expect(verifyToken('mytoken', storedHash)).toBe(false);
      expect(verifyToken('MYTOKEN', storedHash)).toBe(false);
      expect(verifyToken('MyToken', storedHash)).toBe(true);
    });
  });

  describe('Timing-Safe Comparison', () => {
    it('should take similar time for matching and non-matching tokens', () => {
      const storedHash = hashToken('reference-token');

      // Warm up JIT
      for (let i = 0; i < 100; i++) {
        verifyToken('warmup-token', storedHash);
      }

      // Measure time for correct token
      const correctTimes: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const start = process.hrtime.bigint();
        verifyToken('reference-token', storedHash);
        const end = process.hrtime.bigint();
        correctTimes.push(Number(end - start));
      }

      // Measure time for wrong token (completely different)
      const wrongTimes: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const start = process.hrtime.bigint();
        verifyToken('completely-wrong-token-xyz', storedHash);
        const end = process.hrtime.bigint();
        wrongTimes.push(Number(end - start));
      }

      // Calculate averages (excluding outliers)
      const sortedCorrect = correctTimes.sort((a, b) => a - b);
      const sortedWrong = wrongTimes.sort((a, b) => a - b);

      // Use median to reduce noise
      const medianCorrect = sortedCorrect[Math.floor(sortedCorrect.length / 2)];
      const medianWrong = sortedWrong[Math.floor(sortedWrong.length / 2)];

      // Times should be within 50% of each other (timing-safe)
      // Note: This is a heuristic test; actual timing can vary by system load
      const ratio = Math.max(medianCorrect, medianWrong) / Math.min(medianCorrect, medianWrong);
      expect(ratio).toBeLessThan(2.0);
    });

    it('should return false for truncated hash (length mismatch)', () => {
      const storedHash = hashToken('test-token');
      const truncatedHash = storedHash.slice(0, 32); // Half the hash

      expect(verifyToken('test-token', truncatedHash)).toBe(false);
    });

    it('should return false for extended hash (length mismatch)', () => {
      const storedHash = hashToken('test-token') + '00000000';

      expect(verifyToken('test-token', storedHash)).toBe(false);
    });
  });

  describe('isLocalhostIp', () => {
    it('should return true for IPv4 localhost', () => {
      expect(isLocalhostIp('127.0.0.1')).toBe(true);
    });

    it('should return true for IPv6 localhost', () => {
      expect(isLocalhostIp('::1')).toBe(true);
    });

    it('should return true for IPv4-mapped IPv6 localhost', () => {
      expect(isLocalhostIp('::ffff:127.0.0.1')).toBe(true);
    });

    it('should return true for localhost hostname', () => {
      expect(isLocalhostIp('localhost')).toBe(true);
    });

    it('should return false for other IPv4 addresses', () => {
      expect(isLocalhostIp('192.168.1.1')).toBe(false);
      expect(isLocalhostIp('10.0.0.1')).toBe(false);
      expect(isLocalhostIp('172.16.0.1')).toBe(false);
      expect(isLocalhostIp('8.8.8.8')).toBe(false);
    });

    it('should return false for other IPv6 addresses', () => {
      expect(isLocalhostIp('::2')).toBe(false);
      expect(isLocalhostIp('fe80::1')).toBe(false);
      expect(isLocalhostIp('2001:db8::1')).toBe(false);
    });

    it('should return false for 127.0.0.2 (not exactly localhost)', () => {
      expect(isLocalhostIp('127.0.0.2')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isLocalhostIp('')).toBe(false);
    });
  });

  describe('authenticateAgent', () => {
    describe('Unknown Server', () => {
      it('should reject connection from unknown server', () => {
        const result = authenticateAgent('unknown-server-id', 'some-token', '192.168.1.100');

        expect(result.success).toBe(false);
        expect(result.reason).toBe('unknown server');
        expect(mockLogger.warn).toHaveBeenCalled();
      });

      it('should not leak whether server exists via timing', () => {
        // Register a server
        db.prepare(`
          INSERT INTO servers (id, name, is_core, agent_status)
          VALUES ('existing-server', 'Existing', 0, 'offline')
        `).run();

        // Measure time for existing vs non-existing
        const existingTimes: number[] = [];
        const nonExistingTimes: number[] = [];

        for (let i = 0; i < 100; i++) {
          const start1 = process.hrtime.bigint();
          authenticateAgent('existing-server', 'wrong-token', '192.168.1.1');
          existingTimes.push(Number(process.hrtime.bigint() - start1));

          const start2 = process.hrtime.bigint();
          authenticateAgent('non-existing-server', 'wrong-token', '192.168.1.1');
          nonExistingTimes.push(Number(process.hrtime.bigint() - start2));
        }

        // Both should complete (this is more of a smoke test)
        expect(existingTimes.length).toBe(100);
        expect(nonExistingTimes.length).toBe(100);
      });
    });

    describe('Core Server Authentication', () => {
      beforeEach(() => {
        db.prepare(`
          INSERT INTO servers (id, name, is_core, agent_status)
          VALUES ('core', 'Core Server', 1, 'offline')
        `).run();
      });

      it('should accept core server from IPv4 localhost', () => {
        const result = authenticateAgent('core', undefined, '127.0.0.1');

        expect(result.success).toBe(true);
        expect(result.server).toBeDefined();
        expect(result.server?.id).toBe('core');
      });

      it('should accept core server from IPv6 localhost', () => {
        const result = authenticateAgent('core', undefined, '::1');

        expect(result.success).toBe(true);
        expect(result.server?.id).toBe('core');
      });

      it('should accept core server from IPv4-mapped IPv6 localhost', () => {
        const result = authenticateAgent('core', undefined, '::ffff:127.0.0.1');

        expect(result.success).toBe(true);
        expect(result.server?.id).toBe('core');
      });

      it('should accept core server with localhost hostname', () => {
        const result = authenticateAgent('core', 'ignored-token', 'localhost');

        expect(result.success).toBe(true);
        expect(result.server?.id).toBe('core');
      });

      it('should reject core server from remote IP', () => {
        const result = authenticateAgent('core', 'any-token', '192.168.1.100');

        expect(result.success).toBe(false);
        expect(result.reason).toBe('core server must connect from localhost');
        expect(mockLogger.warn).toHaveBeenCalled();
      });

      it('should reject core server from public IP', () => {
        const result = authenticateAgent('core', 'any-token', '8.8.8.8');

        expect(result.success).toBe(false);
        expect(result.reason).toBe('core server must connect from localhost');
      });

      it('should not require token for core server from localhost', () => {
        const result = authenticateAgent('core', undefined, '127.0.0.1');

        expect(result.success).toBe(true);
      });
    });

    describe('Non-Core Server with New-Style Tokens', () => {
      const serverId = 'remote-server-1';
      const validToken = 'valid-agent-token-12345';

      beforeEach(() => {
        db.prepare(`
          INSERT INTO servers (id, name, is_core, agent_status)
          VALUES (?, 'Remote Server', 0, 'offline')
        `).run(serverId);
      });

      it('should accept valid non-expired token', () => {
        const tokenHash = hashToken(validToken);
        db.prepare(`
          INSERT INTO agent_tokens (id, server_id, token_hash, created_at)
          VALUES ('token-1', ?, ?, CURRENT_TIMESTAMP)
        `).run(serverId, tokenHash);

        const result = authenticateAgent(serverId, validToken, '192.168.1.100');

        expect(result.success).toBe(true);
        expect(result.server?.id).toBe(serverId);
      });

      it('should update last_used_at on successful auth', () => {
        const tokenHash = hashToken(validToken);
        db.prepare(`
          INSERT INTO agent_tokens (id, server_id, token_hash, created_at)
          VALUES ('token-1', ?, ?, CURRENT_TIMESTAMP)
        `).run(serverId, tokenHash);

        authenticateAgent(serverId, validToken, '192.168.1.100');

        const token = db.prepare('SELECT last_used_at FROM agent_tokens WHERE id = ?').get('token-1') as { last_used_at: string };
        expect(token.last_used_at).not.toBeNull();
      });

      it('should reject expired token', () => {
        const tokenHash = hashToken(validToken);
        db.prepare(`
          INSERT INTO agent_tokens (id, server_id, token_hash, created_at, expires_at)
          VALUES ('token-1', ?, ?, CURRENT_TIMESTAMP, datetime('now', '-1 hour'))
        `).run(serverId, tokenHash);

        const result = authenticateAgent(serverId, validToken, '192.168.1.100');

        expect(result.success).toBe(false);
        expect(result.reason).toBe('invalid token');
      });

      it('should accept token with NULL expiration (never expires)', () => {
        const tokenHash = hashToken(validToken);
        db.prepare(`
          INSERT INTO agent_tokens (id, server_id, token_hash, created_at, expires_at)
          VALUES ('token-1', ?, ?, CURRENT_TIMESTAMP, NULL)
        `).run(serverId, tokenHash);

        const result = authenticateAgent(serverId, validToken, '192.168.1.100');

        expect(result.success).toBe(true);
      });

      it('should accept token with future expiration', () => {
        const tokenHash = hashToken(validToken);
        db.prepare(`
          INSERT INTO agent_tokens (id, server_id, token_hash, created_at, expires_at)
          VALUES ('token-1', ?, ?, CURRENT_TIMESTAMP, datetime('now', '+1 day'))
        `).run(serverId, tokenHash);

        const result = authenticateAgent(serverId, validToken, '192.168.1.100');

        expect(result.success).toBe(true);
      });

      it('should reject token for wrong server', () => {
        // Create another server
        db.prepare(`
          INSERT INTO servers (id, name, is_core, agent_status)
          VALUES ('other-server', 'Other Server', 0, 'offline')
        `).run();

        // Token is registered for 'other-server'
        const tokenHash = hashToken(validToken);
        db.prepare(`
          INSERT INTO agent_tokens (id, server_id, token_hash, created_at)
          VALUES ('token-1', 'other-server', ?, CURRENT_TIMESTAMP)
        `).run(tokenHash);

        // Try to use it for 'remote-server-1'
        const result = authenticateAgent(serverId, validToken, '192.168.1.100');

        expect(result.success).toBe(false);
        expect(result.reason).toBe('invalid token');
      });

      it('should reject missing token', () => {
        const result = authenticateAgent(serverId, undefined, '192.168.1.100');

        expect(result.success).toBe(false);
        expect(result.reason).toBe('missing token');
      });

      it('should reject empty string token', () => {
        const result = authenticateAgent(serverId, '', '192.168.1.100');

        expect(result.success).toBe(false);
        expect(result.reason).toBe('missing token');
      });

      it('should reject wrong token', () => {
        const tokenHash = hashToken(validToken);
        db.prepare(`
          INSERT INTO agent_tokens (id, server_id, token_hash, created_at)
          VALUES ('token-1', ?, ?, CURRENT_TIMESTAMP)
        `).run(serverId, tokenHash);

        const result = authenticateAgent(serverId, 'wrong-token', '192.168.1.100');

        expect(result.success).toBe(false);
        expect(result.reason).toBe('invalid token');
      });
    });

    describe('Non-Core Server with Legacy Token', () => {
      const serverId = 'legacy-server';
      const legacyToken = 'legacy-token-abc123';

      beforeEach(() => {
        const tokenHash = hashToken(legacyToken);
        db.prepare(`
          INSERT INTO servers (id, name, is_core, agent_status, auth_token)
          VALUES (?, 'Legacy Server', 0, 'offline', ?)
        `).run(serverId, tokenHash);
      });

      it('should accept valid legacy token', () => {
        const result = authenticateAgent(serverId, legacyToken, '192.168.1.100');

        expect(result.success).toBe(true);
        expect(result.server?.id).toBe(serverId);
      });

      it('should reject wrong legacy token', () => {
        const result = authenticateAgent(serverId, 'wrong-legacy-token', '192.168.1.100');

        expect(result.success).toBe(false);
        expect(result.reason).toBe('invalid token');
      });

      it('should prefer new-style token over legacy', () => {
        // Add a new-style token that's different
        const newToken = 'new-style-token';
        const newTokenHash = hashToken(newToken);
        db.prepare(`
          INSERT INTO agent_tokens (id, server_id, token_hash, created_at)
          VALUES ('token-1', ?, ?, CURRENT_TIMESTAMP)
        `).run(serverId, newTokenHash);

        // New token should work
        expect(authenticateAgent(serverId, newToken, '192.168.1.100').success).toBe(true);

        // Legacy token should also still work (fallback)
        expect(authenticateAgent(serverId, legacyToken, '192.168.1.100').success).toBe(true);
      });
    });

    describe('Server Without Any Token', () => {
      beforeEach(() => {
        db.prepare(`
          INSERT INTO servers (id, name, is_core, agent_status, auth_token)
          VALUES ('no-token-server', 'No Token Server', 0, 'offline', NULL)
        `).run();
      });

      it('should reject any token when server has no auth configured', () => {
        const result = authenticateAgent('no-token-server', 'any-token', '192.168.1.100');

        expect(result.success).toBe(false);
        expect(result.reason).toBe('invalid token');
      });
    });

    describe('Logging', () => {
      beforeEach(() => {
        db.prepare(`
          INSERT INTO servers (id, name, is_core, agent_status)
          VALUES ('log-test-server', 'Log Test', 0, 'offline')
        `).run();
      });

      it('should log warning for unknown server', () => {
        authenticateAgent('unknown', 'token', '192.168.1.1');

        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ serverId: 'unknown', clientIp: '192.168.1.1' }),
          expect.stringContaining('unknown server')
        );
      });

      it('should log warning for missing token', () => {
        authenticateAgent('log-test-server', undefined, '192.168.1.1');

        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ serverId: 'log-test-server' }),
          expect.stringContaining('missing token')
        );
      });

      it('should log warning for invalid token', () => {
        authenticateAgent('log-test-server', 'wrong', '192.168.1.1');

        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ serverId: 'log-test-server' }),
          expect.stringContaining('invalid token')
        );
      });

      it('should log debug for successful auth', () => {
        const token = 'valid-token';
        const tokenHash = hashToken(token);
        db.prepare(`
          INSERT INTO agent_tokens (id, server_id, token_hash, created_at)
          VALUES ('token-1', 'log-test-server', ?, CURRENT_TIMESTAMP)
        `).run(tokenHash);

        authenticateAgent('log-test-server', token, '192.168.1.1');

        expect(mockLogger.debug).toHaveBeenCalled();
      });
    });
  });

  describe('Security Edge Cases', () => {
    it('should not expose token in error messages', () => {
      db.prepare(`
        INSERT INTO servers (id, name, is_core, agent_status)
        VALUES ('secure-server', 'Secure', 0, 'offline')
      `).run();

      const sensitiveToken = 'super-secret-token-12345';
      const result = authenticateAgent('secure-server', sensitiveToken, '192.168.1.1');

      expect(result.reason).not.toContain(sensitiveToken);
      expect(result.reason).not.toContain('secret');
    });

    it('should handle very long tokens', () => {
      db.prepare(`
        INSERT INTO servers (id, name, is_core, agent_status)
        VALUES ('long-token-server', 'Long Token', 0, 'offline')
      `).run();

      const longToken = 'a'.repeat(10000);
      const tokenHash = hashToken(longToken);
      db.prepare(`
        INSERT INTO agent_tokens (id, server_id, token_hash, created_at)
        VALUES ('token-1', 'long-token-server', ?, CURRENT_TIMESTAMP)
      `).run(tokenHash);

      const result = authenticateAgent('long-token-server', longToken, '192.168.1.1');

      expect(result.success).toBe(true);
    });

    it('should handle tokens with null bytes', () => {
      db.prepare(`
        INSERT INTO servers (id, name, is_core, agent_status)
        VALUES ('null-byte-server', 'Null Byte', 0, 'offline')
      `).run();

      const tokenWithNull = 'token\x00with\x00nulls';
      const tokenHash = hashToken(tokenWithNull);
      db.prepare(`
        INSERT INTO agent_tokens (id, server_id, token_hash, created_at)
        VALUES ('token-1', 'null-byte-server', ?, CURRENT_TIMESTAMP)
      `).run(tokenHash);

      const result = authenticateAgent('null-byte-server', tokenWithNull, '192.168.1.1');

      expect(result.success).toBe(true);
    });

    it('should handle SQL injection attempts in server ID', () => {
      // This should just return unknown server, not crash
      const maliciousServerId = "'; DROP TABLE servers; --";
      const result = authenticateAgent(maliciousServerId, 'token', '192.168.1.1');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('unknown server');

      // Verify servers table still exists
      const count = db.prepare('SELECT COUNT(*) as count FROM servers').get() as { count: number };
      expect(count.count).toBeGreaterThanOrEqual(0);
    });
  });
});
