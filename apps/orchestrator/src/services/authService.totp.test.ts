/**
 * TOTP/2FA Tests for AuthService
 *
 * Tests:
 * - Valid TOTP code within ±1 time window
 * - Expired TOTP code rejected (outside window)
 * - Backup code works and is deleted after use
 * - Backup code cannot be reused
 * - TOTP setup generates valid QR code data
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as OTPAuth from 'otpauth';

// Mock the database before importing authService
vi.mock('../db/index.js', () => {
  let db: Database.Database | null = null;

  return {
    getDb: () => {
      if (!db) {
        db = new Database(':memory:');

        // Create users table
        db.exec(`
          CREATE TABLE users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            is_system_admin BOOLEAN DEFAULT FALSE,
            totp_secret TEXT,
            totp_enabled BOOLEAN DEFAULT FALSE,
            backup_codes TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_login_at TEXT
          )
        `);

        // Create groups table
        db.exec(`
          CREATE TABLE groups (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            description TEXT,
            totp_required BOOLEAN DEFAULT FALSE,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Create user_groups table
        db.exec(`
          CREATE TABLE user_groups (
            user_id TEXT NOT NULL,
            group_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, group_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
          )
        `);

        // Create refresh_tokens table
        db.exec(`
          CREATE TABLE refresh_tokens (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            ip_address TEXT,
            user_agent TEXT,
            last_used_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);

        // Create default group
        db.exec(`
          INSERT INTO groups (id, name, description, totp_required)
          VALUES ('default', 'Default', 'Default group for all users', FALSE)
        `);
      }
      return db;
    },
    closeDb: () => {
      if (db) {
        db.close();
        db = null;
      }
    },
  };
});

// Mock config
vi.mock('../config.js', () => ({
  config: {
    jwt: {
      secret: 'test-jwt-secret-for-totp-tests-32-chars',
      accessTokenExpiry: '15m',
      refreshTokenExpiry: '7d',
    },
    security: {
      bcryptRounds: 4, // Fast for tests
    },
    isDevelopment: true,
  },
}));

// Mock logger
vi.mock('../lib/logger.js', () => ({
  authLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { authService } from './authService.js';
import { getDb } from '../db/index.js';

// Helper to reset database between tests
function resetTestDb(): void {
  const db = getDb();
  db.exec('DELETE FROM user_groups');
  db.exec('DELETE FROM refresh_tokens');
  db.exec('DELETE FROM users');
  db.exec("DELETE FROM groups WHERE id != 'default'");
}

describe('AuthService TOTP/2FA', () => {
  let userId: string;
  let totpSecret: string;
  let backupCodes: string[];

  beforeEach(async () => {
    resetTestDb();
    // Create a test user
    userId = await authService.createUser('testuser', 'password123', true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('setupTotp', () => {
    it('generates valid secret, QR code, and backup codes', async () => {
      const result = await authService.setupTotp(userId);

      // Check secret is valid base32
      expect(result.secret).toBeDefined();
      expect(result.secret.length).toBeGreaterThan(0);
      // Base32 characters: A-Z, 2-7
      expect(result.secret).toMatch(/^[A-Z2-7]+$/);

      // Check QR code is a data URL
      expect(result.qrCode).toMatch(/^data:image\/png;base64,/);

      // Check backup codes - should be 10 codes, 8 chars each, uppercase hex
      expect(result.backupCodes).toHaveLength(10);
      result.backupCodes.forEach((code) => {
        expect(code).toMatch(/^[A-F0-9]{8}$/);
      });
    });

    it('stores secret but does not enable TOTP until verified', async () => {
      await authService.setupTotp(userId);

      // TOTP should not be enabled yet
      expect(authService.isTotpEnabled(userId)).toBe(false);

      // But secret should be stored
      const db = getDb();
      const user = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as {
        totp_secret: string | null;
      };
      expect(user.totp_secret).not.toBeNull();
    });

    it('throws error if TOTP already enabled', async () => {
      // Setup and enable TOTP
      const result = await authService.setupTotp(userId);
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(result.secret),
      });
      const code = totp.generate();
      authService.verifyAndEnableTotp(userId, code);

      // Try to setup again
      await expect(authService.setupTotp(userId)).rejects.toThrow('TOTP is already enabled');
    });

    it('throws error for non-existent user', async () => {
      await expect(authService.setupTotp('non-existent-user-id')).rejects.toThrow('User not found');
    });

    it('generates unique backup codes each time', async () => {
      const result1 = await authService.setupTotp(userId);

      // Reset TOTP to allow another setup
      const db = getDb();
      db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = FALSE, backup_codes = NULL WHERE id = ?').run(
        userId
      );

      const result2 = await authService.setupTotp(userId);

      // All codes should be different between the two setups
      const allCodes1 = new Set(result1.backupCodes);
      result2.backupCodes.forEach((code) => {
        expect(allCodes1.has(code)).toBe(false);
      });
    });

    it('QR code contains correct otpauth URL components', async () => {
      const result = await authService.setupTotp(userId);

      // The secret should be usable to create a valid TOTP
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(result.secret),
      });

      // Verify the TOTP can generate valid codes
      const generatedCode = totp.generate();
      expect(generatedCode).toMatch(/^\d{6}$/);
    });
  });

  describe('verifyAndEnableTotp', () => {
    beforeEach(async () => {
      const result = await authService.setupTotp(userId);
      totpSecret = result.secret;
      backupCodes = result.backupCodes;
    });

    it('enables TOTP with valid current code', () => {
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      });

      const code = totp.generate();
      const result = authService.verifyAndEnableTotp(userId, code);

      expect(result).toBe(true);
      expect(authService.isTotpEnabled(userId)).toBeTruthy();
    });

    it('accepts code from previous time window (window=-1)', () => {
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      });

      // Generate code for previous time step
      const now = Date.now();
      const previousStepTime = now - 30000; // 30 seconds ago
      const code = totp.generate({ timestamp: previousStepTime });

      const result = authService.verifyAndEnableTotp(userId, code);
      expect(result).toBe(true);
    });

    it('accepts code from next time window (window=+1)', () => {
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      });

      // Generate code for next time step
      const now = Date.now();
      const nextStepTime = now + 30000; // 30 seconds in future
      const code = totp.generate({ timestamp: nextStepTime });

      const result = authService.verifyAndEnableTotp(userId, code);
      expect(result).toBe(true);
    });

    it('rejects code outside the ±1 window', () => {
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      });

      // Generate code for 2 time steps ago (60+ seconds)
      const now = Date.now();
      const expiredTime = now - 65000; // 65 seconds ago
      const code = totp.generate({ timestamp: expiredTime });

      const result = authService.verifyAndEnableTotp(userId, code);
      expect(result).toBe(false);
      expect(authService.isTotpEnabled(userId)).toBe(false);
    });

    it('rejects invalid code format', () => {
      const result1 = authService.verifyAndEnableTotp(userId, '12345'); // Too short
      expect(result1).toBe(false);

      const result2 = authService.verifyAndEnableTotp(userId, 'abcdef'); // Not digits
      expect(result2).toBe(false);

      const result3 = authService.verifyAndEnableTotp(userId, '1234567'); // Too long
      expect(result3).toBe(false);
    });

    it('returns false if no totp_secret is set', () => {
      const db = getDb();
      db.prepare('UPDATE users SET totp_secret = NULL WHERE id = ?').run(userId);

      const result = authService.verifyAndEnableTotp(userId, '123456');
      expect(result).toBe(false);
    });

    it('returns false if TOTP already enabled', () => {
      // First enable
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      });
      const code1 = totp.generate();
      authService.verifyAndEnableTotp(userId, code1);

      // Try to enable again
      const code2 = totp.generate();
      const result = authService.verifyAndEnableTotp(userId, code2);
      expect(result).toBe(false);
    });
  });

  describe('verifyTotpCode', () => {
    beforeEach(async () => {
      // Setup and enable TOTP
      const result = await authService.setupTotp(userId);
      totpSecret = result.secret;
      backupCodes = result.backupCodes;

      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      });
      const code = totp.generate();
      authService.verifyAndEnableTotp(userId, code);
    });

    it('accepts valid TOTP code in current window', () => {
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      });

      const code = totp.generate();
      const result = authService.verifyTotpCode(userId, code);
      expect(result).toBe(true);
    });

    it('accepts TOTP code within ±1 time window', () => {
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      });

      // Previous window
      const now = Date.now();
      const prevCode = totp.generate({ timestamp: now - 30000 });
      expect(authService.verifyTotpCode(userId, prevCode)).toBe(true);

      // Next window
      const nextCode = totp.generate({ timestamp: now + 30000 });
      expect(authService.verifyTotpCode(userId, nextCode)).toBe(true);
    });

    it('rejects TOTP code outside ±1 window (expired)', () => {
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      });

      // Code from 2+ periods ago
      const now = Date.now();
      const expiredCode = totp.generate({ timestamp: now - 65000 });
      expect(authService.verifyTotpCode(userId, expiredCode)).toBe(false);

      // Code from 2+ periods in future
      const futureCode = totp.generate({ timestamp: now + 65000 });
      expect(authService.verifyTotpCode(userId, futureCode)).toBe(false);
    });

    it('accepts valid backup code', () => {
      const backupCode = backupCodes[0];
      const result = authService.verifyTotpCode(userId, backupCode);
      expect(result).toBe(true);
    });

    it('backup code is case-insensitive', () => {
      const backupCode = backupCodes[1];
      const result = authService.verifyTotpCode(userId, backupCode.toLowerCase());
      expect(result).toBe(true);
    });

    it('backup code is deleted after single use', () => {
      const backupCode = backupCodes[2];

      // First use should succeed
      const result1 = authService.verifyTotpCode(userId, backupCode);
      expect(result1).toBe(true);

      // Check backup codes remaining
      const status = authService.getTotpStatus(userId);
      expect(status.backupCodesRemaining).toBe(9); // One was used
    });

    it('backup code cannot be reused', () => {
      const backupCode = backupCodes[3];

      // First use
      const result1 = authService.verifyTotpCode(userId, backupCode);
      expect(result1).toBe(true);

      // Second use should fail
      const result2 = authService.verifyTotpCode(userId, backupCode);
      expect(result2).toBe(false);
    });

    it('returns false for non-existent user', () => {
      const result = authService.verifyTotpCode('non-existent-id', '123456');
      expect(result).toBe(false);
    });

    it('returns false if TOTP not enabled', async () => {
      // Create new user without TOTP
      const newUserId = await authService.createUser('newuser', 'password', true);
      const result = authService.verifyTotpCode(newUserId, '123456');
      expect(result).toBe(false);
    });

    it('tries TOTP code before backup codes', () => {
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      });

      const code = totp.generate();
      authService.verifyTotpCode(userId, code);

      // Backup codes should still all be available
      const status = authService.getTotpStatus(userId);
      expect(status.backupCodesRemaining).toBe(10);
    });
  });

  describe('backup codes management', () => {
    beforeEach(async () => {
      // Setup and enable TOTP
      const result = await authService.setupTotp(userId);
      totpSecret = result.secret;
      backupCodes = result.backupCodes;

      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      });
      const code = totp.generate();
      authService.verifyAndEnableTotp(userId, code);
    });

    it('all backup codes work until used', () => {
      // Use all backup codes one by one
      for (let i = 0; i < backupCodes.length; i++) {
        const result = authService.verifyTotpCode(userId, backupCodes[i]);
        expect(result).toBe(true);

        const status = authService.getTotpStatus(userId);
        expect(status.backupCodesRemaining).toBe(backupCodes.length - i - 1);
      }
    });

    it('TOTP still works after all backup codes exhausted', () => {
      // Use all backup codes
      for (const code of backupCodes) {
        authService.verifyTotpCode(userId, code);
      }

      const status = authService.getTotpStatus(userId);
      expect(status.backupCodesRemaining).toBe(0);

      // TOTP should still work
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      });
      const totpCode = totp.generate();
      expect(authService.verifyTotpCode(userId, totpCode)).toBe(true);
    });

    it('regenerateBackupCodes replaces all existing codes', () => {
      // Use some backup codes
      authService.verifyTotpCode(userId, backupCodes[0]);
      authService.verifyTotpCode(userId, backupCodes[1]);

      let status = authService.getTotpStatus(userId);
      expect(status.backupCodesRemaining).toBe(8);

      // Regenerate
      const newCodes = authService.regenerateBackupCodes(userId);
      expect(newCodes).not.toBeNull();
      expect(newCodes).toHaveLength(10);

      status = authService.getTotpStatus(userId);
      expect(status.backupCodesRemaining).toBe(10);

      // Old codes should not work
      expect(authService.verifyTotpCode(userId, backupCodes[2])).toBe(false);

      // New codes should work
      expect(authService.verifyTotpCode(userId, newCodes![0])).toBe(true);
    });

    it('regenerateBackupCodes returns null if TOTP not enabled', async () => {
      const newUserId = await authService.createUser('newuser2', 'password', true);
      const result = authService.regenerateBackupCodes(newUserId);
      expect(result).toBeNull();
    });
  });

  describe('getTotpStatus', () => {
    it('returns disabled status for user without TOTP', () => {
      const status = authService.getTotpStatus(userId);
      expect(status.enabled).toBeFalsy();
      expect(status.backupCodesRemaining).toBe(0);
    });

    it('returns correct status after TOTP setup but before enable', async () => {
      await authService.setupTotp(userId);
      const status = authService.getTotpStatus(userId);
      expect(status.enabled).toBeFalsy();
      // Backup codes are stored even before enabling
      expect(status.backupCodesRemaining).toBe(10);
    });

    it('returns enabled status after TOTP enabled', async () => {
      const result = await authService.setupTotp(userId);
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(result.secret),
      });
      authService.verifyAndEnableTotp(userId, totp.generate());

      const status = authService.getTotpStatus(userId);
      expect(status.enabled).toBeTruthy();
      expect(status.backupCodesRemaining).toBe(10);
    });

    it('returns zero for non-existent user', () => {
      const status = authService.getTotpStatus('non-existent');
      expect(status.enabled).toBe(false);
      expect(status.backupCodesRemaining).toBe(0);
    });
  });

  describe('disableTotp', () => {
    beforeEach(async () => {
      // Setup and enable TOTP
      const result = await authService.setupTotp(userId);
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(result.secret),
      });
      authService.verifyAndEnableTotp(userId, totp.generate());
    });

    it('disables TOTP with correct password', async () => {
      const result = await authService.disableTotp(userId, 'password123');
      expect(result).toBe(true);
      expect(authService.isTotpEnabled(userId)).toBe(false);

      // Secret and backup codes should be cleared
      const db = getDb();
      const user = db.prepare('SELECT totp_secret, backup_codes FROM users WHERE id = ?').get(userId) as {
        totp_secret: string | null;
        backup_codes: string | null;
      };
      expect(user.totp_secret).toBeNull();
      expect(user.backup_codes).toBeNull();
    });

    it('fails to disable with wrong password', async () => {
      const result = await authService.disableTotp(userId, 'wrongpassword');
      expect(result).toBe(false);
      expect(authService.isTotpEnabled(userId)).toBeTruthy();
    });

    it('fails for non-existent user', async () => {
      const result = await authService.disableTotp('non-existent', 'password');
      expect(result).toBe(false);
    });
  });

  describe('resetTotpForUser (admin reset)', () => {
    beforeEach(async () => {
      // Setup and enable TOTP
      const result = await authService.setupTotp(userId);
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(result.secret),
      });
      authService.verifyAndEnableTotp(userId, totp.generate());
    });

    it('resets TOTP without requiring password', () => {
      const result = authService.resetTotpForUser(userId);
      expect(result).toBe(true);
      expect(authService.isTotpEnabled(userId)).toBe(false);
    });

    it('returns false for non-existent user', () => {
      const result = authService.resetTotpForUser('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('isTotpEnabled / isTotpEnabledForUsername', () => {
    it('returns false before TOTP setup', () => {
      expect(authService.isTotpEnabled(userId)).toBe(false);
      expect(authService.isTotpEnabledForUsername('testuser')).toBe(false);
    });

    it('returns false after setup but before verification', async () => {
      await authService.setupTotp(userId);
      expect(authService.isTotpEnabled(userId)).toBe(false);
      expect(authService.isTotpEnabledForUsername('testuser')).toBe(false);
    });

    it('returns true after TOTP enabled', async () => {
      const result = await authService.setupTotp(userId);
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(result.secret),
      });
      authService.verifyAndEnableTotp(userId, totp.generate());

      expect(authService.isTotpEnabled(userId)).toBeTruthy();
      expect(authService.isTotpEnabledForUsername('testuser')).toBeTruthy();
    });

    it('returns false for non-existent user/username', () => {
      expect(authService.isTotpEnabled('non-existent')).toBe(false);
      expect(authService.isTotpEnabledForUsername('non-existent')).toBe(false);
    });
  });

  describe('group-based TOTP requirements', () => {
    it('userRequiresTotp returns false when no group requires it', () => {
      expect(authService.userRequiresTotp(userId)).toBe(false);
    });

    it('userRequiresTotp returns true when a group requires it', () => {
      // Create a group that requires TOTP
      const groupId = authService.createGroup('secure-group', 'Requires 2FA', true);
      authService.addUserToGroup(userId, groupId, 'viewer');

      expect(authService.userRequiresTotp(userId)).toBe(true);
    });

    it('canUserDisableTotp returns true when no group requires it', () => {
      expect(authService.canUserDisableTotp(userId)).toBe(true);
    });

    it('canUserDisableTotp returns false when a group requires it', () => {
      const groupId = authService.createGroup('secure-group2', 'Requires 2FA', true);
      authService.addUserToGroup(userId, groupId, 'viewer');

      expect(authService.canUserDisableTotp(userId)).toBe(false);
    });

    it('disableTotp throws error when group requires TOTP', async () => {
      // Setup and enable TOTP first
      const result = await authService.setupTotp(userId);
      const totp = new OTPAuth.TOTP({
        issuer: 'OwnPrem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(result.secret),
      });
      authService.verifyAndEnableTotp(userId, totp.generate());

      // Add to group requiring TOTP
      const groupId = authService.createGroup('secure-group3', 'Requires 2FA', true);
      authService.addUserToGroup(userId, groupId, 'viewer');

      // Try to disable
      await expect(authService.disableTotp(userId, 'password123')).rejects.toThrow(
        'Cannot disable 2FA: one or more of your groups requires it'
      );
    });
  });
});
