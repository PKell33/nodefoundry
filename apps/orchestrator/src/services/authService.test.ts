import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Mock the database
const __dirname = dirname(fileURLToPath(import.meta.url));
let db: Database.Database;

// Mock the modules before importing authService
import { vi } from 'vitest';

vi.mock('../db/index.js', () => ({
  getDb: () => db,
}));

vi.mock('../config.js', () => ({
  config: {
    isDevelopment: true,
    jwt: {
      secret: 'test-jwt-secret-for-testing-purposes',
      accessTokenExpiry: '15m',
      refreshTokenExpiry: '7d',
    },
    security: {
      bcryptRounds: 4, // Lower for faster tests
    },
  },
}));

// Import after mocks
const { authService } = await import('./authService.js');

describe('AuthService', () => {
  beforeAll(() => {
    // Create in-memory database
    db = new Database(':memory:');

    // Load schema
    const schemaPath = join(__dirname, '../db/schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    db.exec(schema);
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    // Clear users table before each test
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM refresh_tokens');
    db.exec('DELETE FROM user_groups');
  });

  describe('createUser', () => {
    it('should create a new user', async () => {
      const userId = await authService.createUser('testuser', 'password123', true);
      expect(userId).toBeDefined();
      expect(typeof userId).toBe('string');
    });

    it('should throw error for duplicate username', async () => {
      await authService.createUser('testuser', 'password123', true);
      await expect(authService.createUser('testuser', 'password456', true))
        .rejects.toThrow('Username already exists');
    });
  });

  describe('validateCredentials', () => {
    beforeEach(async () => {
      await authService.createUser('testuser', 'correctpassword', true);
    });

    it('should return user for valid credentials', async () => {
      const user = await authService.validateCredentials('testuser', 'correctpassword');
      expect(user).toBeDefined();
      expect(user?.username).toBe('testuser');
    });

    it('should return null for invalid password', async () => {
      const user = await authService.validateCredentials('testuser', 'wrongpassword');
      expect(user).toBeNull();
    });

    it('should return null for non-existent user', async () => {
      const user = await authService.validateCredentials('nonexistent', 'password');
      expect(user).toBeNull();
    });
  });

  describe('generateTokens', () => {
    it('should generate access and refresh tokens', async () => {
      await authService.createUser('testuser', 'password123', true);
      const user = await authService.validateCredentials('testuser', 'password123');

      const tokens = authService.generateTokens(user!);

      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();
      expect(tokens.expiresIn).toBe(900);
    });
  });

  describe('verifyAccessToken', () => {
    it('should verify a valid token', async () => {
      await authService.createUser('testuser', 'password123', true);
      const user = await authService.validateCredentials('testuser', 'password123');
      const tokens = authService.generateTokens(user!);

      const payload = authService.verifyAccessToken(tokens.accessToken);

      expect(payload).toBeDefined();
      expect(payload?.username).toBe('testuser');
      expect(payload?.isSystemAdmin).toBe(true);
    });

    it('should return null for invalid token', () => {
      const payload = authService.verifyAccessToken('invalid.token.here');
      expect(payload).toBeNull();
    });
  });

  describe('refreshAccessToken', () => {
    it('should refresh tokens with valid refresh token', async () => {
      await authService.createUser('testuser', 'password123', true);
      const user = await authService.validateCredentials('testuser', 'password123');
      const tokens = authService.generateTokens(user!);

      const newTokens = await authService.refreshAccessToken(tokens.refreshToken);

      expect(newTokens).toBeDefined();
      expect(newTokens?.accessToken).toBeDefined();
      expect(newTokens?.refreshToken).toBeDefined();
    });

    it('should return null for invalid refresh token', async () => {
      const newTokens = await authService.refreshAccessToken('invalid.refresh.token');
      expect(newTokens).toBeNull();
    });
  });

  describe('changePassword', () => {
    it('should change password with correct old password', async () => {
      const userId = await authService.createUser('testuser', 'oldpassword', true);

      const success = await authService.changePassword(userId, 'oldpassword', 'newpassword');

      expect(success).toBe(true);

      // Verify new password works
      const user = await authService.validateCredentials('testuser', 'newpassword');
      expect(user).toBeDefined();
    });

    it('should fail with incorrect old password', async () => {
      const userId = await authService.createUser('testuser', 'oldpassword', true);

      const success = await authService.changePassword(userId, 'wrongpassword', 'newpassword');

      expect(success).toBe(false);
    });
  });
});
