/**
 * SecretsManager Tests
 *
 * Tests for the encryption/decryption system that protects sensitive data.
 * Covers:
 * - AES-256-GCM encryption round-trips
 * - Non-deterministic encryption (random IVs)
 * - Authentication tag verification (tamper detection)
 * - Key derivation consistency
 * - Invalid format detection
 * - Password and username generation
 * - Database storage operations
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Create test database
let db: Database.Database;

// Mock modules before importing SecretsManager
vi.mock('../db/index.js', () => ({
  getDb: () => db,
}));

vi.mock('../config.js', () => ({
  config: {
    isDevelopment: true,
    secrets: {
      key: 'test-secrets-key-32-characters-long!!',
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
  secretsLogger: mockLogger,
}));

// Import after mocks - use fresh instance for each test
const { SecretsManager } = await import('./secretsManager.js');

describe('SecretsManager', () => {
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
    db.exec('DELETE FROM secrets');
    db.exec('DELETE FROM system_settings');
    vi.clearAllMocks();
  });

  describe('Encryption Round-Trip', () => {
    it('should encrypt and decrypt simple object', () => {
      const manager = new SecretsManager();
      const original = { username: 'admin', password: 'secret123' };

      const encrypted = manager.encrypt(original);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toEqual(original);
    });

    it('should encrypt and decrypt complex nested object', () => {
      const manager = new SecretsManager();
      const original = {
        database: {
          host: 'localhost',
          port: 5432,
          credentials: {
            username: 'postgres',
            password: 'super-secret-password',
          },
        },
        apiKeys: ['key1', 'key2', 'key3'],
        enabled: true,
        count: 42,
      };

      const encrypted = manager.encrypt(original);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toEqual(original);
    });

    it('should encrypt and decrypt empty object', () => {
      const manager = new SecretsManager();
      const original = {};

      const encrypted = manager.encrypt(original);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toEqual(original);
    });

    it('should encrypt and decrypt object with special characters', () => {
      const manager = new SecretsManager();
      const original = {
        password: 'p@$$w0rd!#$%^&*()_+-=[]{}|;:\'",.<>?/\\`~',
        unicode: '日本語テスト 🔐 émojis',
        newlines: 'line1\nline2\r\nline3',
      };

      const encrypted = manager.encrypt(original);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toEqual(original);
    });

    it('should handle null and undefined values in object', () => {
      const manager = new SecretsManager();
      const original = {
        nullValue: null,
        definedValue: 'exists',
      };

      const encrypted = manager.encrypt(original);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toEqual(original);
    });
  });

  describe('Non-Deterministic Encryption (Random IVs)', () => {
    it('should produce different ciphertext for same plaintext', () => {
      const manager = new SecretsManager();
      const data = { secret: 'same-data' };

      const encrypted1 = manager.encrypt(data);
      const encrypted2 = manager.encrypt(data);

      // Ciphertexts should be different due to random IV
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to the same value
      expect(manager.decrypt(encrypted1)).toEqual(data);
      expect(manager.decrypt(encrypted2)).toEqual(data);
    });

    it('should have different IVs for each encryption', () => {
      const manager = new SecretsManager();
      const data = { secret: 'test' };

      const encrypted1 = manager.encrypt(data);
      const encrypted2 = manager.encrypt(data);

      // Extract IVs (first component before :)
      const iv1 = encrypted1.split(':')[0];
      const iv2 = encrypted2.split(':')[0];

      expect(iv1).not.toBe(iv2);
    });

    it('should produce unique ciphertexts across 100 encryptions', () => {
      const manager = new SecretsManager();
      const data = { value: 'repeated' };

      const ciphertexts = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ciphertexts.add(manager.encrypt(data));
      }

      // All 100 should be unique
      expect(ciphertexts.size).toBe(100);
    });
  });

  describe('GCM Authentication Tag Verification', () => {
    it('should fail decryption when ciphertext is tampered', () => {
      const manager = new SecretsManager();
      const encrypted = manager.encrypt({ secret: 'original' });

      // Tamper with the encrypted data portion
      const [iv, tag, data] = encrypted.split(':');
      const tamperedData = Buffer.from(data, 'base64');
      tamperedData[0] = tamperedData[0] ^ 0xff; // Flip bits
      const tampered = `${iv}:${tag}:${tamperedData.toString('base64')}`;

      expect(() => manager.decrypt(tampered)).toThrow();
    });

    it('should fail decryption when authentication tag is tampered', () => {
      const manager = new SecretsManager();
      const encrypted = manager.encrypt({ secret: 'original' });

      // Tamper with the tag
      const [iv, tag, data] = encrypted.split(':');
      const tamperedTag = Buffer.from(tag, 'base64');
      tamperedTag[0] = tamperedTag[0] ^ 0xff; // Flip bits
      const tampered = `${iv}:${tamperedTag.toString('base64')}:${data}`;

      expect(() => manager.decrypt(tampered)).toThrow();
    });

    it('should fail decryption when IV is tampered', () => {
      const manager = new SecretsManager();
      const encrypted = manager.encrypt({ secret: 'original' });

      // Tamper with the IV
      const [iv, tag, data] = encrypted.split(':');
      const tamperedIv = Buffer.from(iv, 'base64');
      tamperedIv[0] = tamperedIv[0] ^ 0xff; // Flip bits
      const tampered = `${tamperedIv.toString('base64')}:${tag}:${data}`;

      expect(() => manager.decrypt(tampered)).toThrow();
    });

    it('should fail decryption when entire ciphertext is replaced', () => {
      const manager = new SecretsManager();
      const encrypted1 = manager.encrypt({ secret: 'data1' });
      const encrypted2 = manager.encrypt({ secret: 'data2' });

      // Mix components from different encryptions
      const [iv1] = encrypted1.split(':');
      const [, tag2, data2] = encrypted2.split(':');
      const mixed = `${iv1}:${tag2}:${data2}`;

      expect(() => manager.decrypt(mixed)).toThrow();
    });
  });

  describe('Key Derivation Consistency', () => {
    it('should derive same key from same salt', () => {
      // Create first manager and encrypt
      const manager1 = new SecretsManager();
      const data = { secret: 'test-data' };
      const encrypted = manager1.encrypt(data);

      // Create second manager (uses same salt from DB)
      const manager2 = new SecretsManager();
      const decrypted = manager2.decrypt(encrypted);

      expect(decrypted).toEqual(data);
    });

    it('should persist salt across manager instances', () => {
      const manager1 = new SecretsManager();
      manager1.encrypt({ test: 'init' }); // Initialize and create salt

      // Check salt was stored
      const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('encryption_salt') as { value: string };
      expect(row).toBeDefined();
      expect(row.value).toBeTruthy();

      // Create new manager and verify it uses same salt
      const manager2 = new SecretsManager();
      const encrypted = manager1.encrypt({ shared: 'data' });
      const decrypted = manager2.decrypt(encrypted);

      expect(decrypted).toEqual({ shared: 'data' });
    });

    it('should create salt on first use if not exists', () => {
      // Verify no salt exists
      const before = db.prepare('SELECT COUNT(*) as count FROM system_settings WHERE key = ?').get('encryption_salt') as { count: number };
      expect(before.count).toBe(0);

      // Initialize manager
      const manager = new SecretsManager();
      manager.encrypt({ init: true });

      // Verify salt was created
      const after = db.prepare('SELECT COUNT(*) as count FROM system_settings WHERE key = ?').get('encryption_salt') as { count: number };
      expect(after.count).toBe(1);
    });
  });

  describe('Invalid Format Detection', () => {
    it('should throw error for empty string', () => {
      const manager = new SecretsManager();

      expect(() => manager.decrypt('')).toThrow('Invalid encrypted data format');
    });

    it('should throw error for missing IV', () => {
      const manager = new SecretsManager();

      expect(() => manager.decrypt(':tag:data')).toThrow('Invalid encrypted data format');
    });

    it('should throw error for missing tag', () => {
      const manager = new SecretsManager();

      expect(() => manager.decrypt('iv::data')).toThrow('Invalid encrypted data format');
    });

    it('should throw error for missing data', () => {
      const manager = new SecretsManager();

      expect(() => manager.decrypt('iv:tag:')).toThrow('Invalid encrypted data format');
    });

    it('should throw error for single component', () => {
      const manager = new SecretsManager();

      expect(() => manager.decrypt('onlyonepart')).toThrow('Invalid encrypted data format');
    });

    it('should throw error for two components', () => {
      const manager = new SecretsManager();

      expect(() => manager.decrypt('part1:part2')).toThrow('Invalid encrypted data format');
    });

    it('should throw error for invalid base64 in IV', () => {
      const manager = new SecretsManager();

      // Create valid encrypted data first
      const valid = manager.encrypt({ test: true });
      const [, tag, data] = valid.split(':');

      // Replace IV with invalid base64
      expect(() => manager.decrypt(`!!!invalid!!!:${tag}:${data}`)).toThrow();
    });

    it('should throw error for wrong IV length', () => {
      const manager = new SecretsManager();

      // Create valid encrypted data first
      const valid = manager.encrypt({ test: true });
      const [, tag, data] = valid.split(':');

      // Use too short IV (should be 16 bytes = 24 base64 chars with padding)
      const shortIv = Buffer.from('short').toString('base64');
      expect(() => manager.decrypt(`${shortIv}:${tag}:${data}`)).toThrow();
    });
  });

  describe('Password Generation', () => {
    it('should generate password of default length (32)', () => {
      const manager = new SecretsManager();
      const password = manager.generatePassword();

      expect(password.length).toBe(32);
    });

    it('should generate password of specified length', () => {
      const manager = new SecretsManager();

      expect(manager.generatePassword(16).length).toBe(16);
      expect(manager.generatePassword(64).length).toBe(64);
      expect(manager.generatePassword(8).length).toBe(8);
    });

    it('should only use alphanumeric characters', () => {
      const manager = new SecretsManager();
      const password = manager.generatePassword(100);

      expect(password).toMatch(/^[a-zA-Z0-9]+$/);
    });

    it('should generate unique passwords', () => {
      const manager = new SecretsManager();
      const passwords = new Set<string>();

      for (let i = 0; i < 100; i++) {
        passwords.add(manager.generatePassword());
      }

      expect(passwords.size).toBe(100);
    });

    it('should have good character distribution', () => {
      const manager = new SecretsManager();
      const password = manager.generatePassword(1000);

      // Check that we have both upper and lower case and digits
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
    });
  });

  describe('Username Generation', () => {
    it('should generate username with default prefix', () => {
      const manager = new SecretsManager();
      const username = manager.generateUsername();

      expect(username).toMatch(/^user_[a-f0-9]{8}$/);
    });

    it('should generate username with custom prefix', () => {
      const manager = new SecretsManager();
      const username = manager.generateUsername('myapp');

      expect(username).toMatch(/^myapp_[a-f0-9]{8}$/);
    });

    it('should generate unique usernames', () => {
      const manager = new SecretsManager();
      const usernames = new Set<string>();

      for (let i = 0; i < 100; i++) {
        usernames.add(manager.generateUsername('test'));
      }

      expect(usernames.size).toBe(100);
    });
  });

  describe('Database Storage Operations', () => {
    // Helper to create required FK records
    function createDeployment(deploymentId: string) {
      // Insert server if not exists
      db.prepare(`
        INSERT OR IGNORE INTO servers (id, name, host, is_core)
        VALUES ('test-server', 'Test Server', 'localhost', 0)
      `).run();

      // Insert app_registry if not exists
      db.prepare(`
        INSERT OR IGNORE INTO app_registry (name, manifest, system)
        VALUES ('test-app', '{}', 0)
      `).run();

      // Insert deployment
      db.prepare(`
        INSERT OR REPLACE INTO deployments (id, server_id, app_name, version, config, status)
        VALUES (?, 'test-server', 'test-app', '1.0.0', '{}', 'running')
      `).run(deploymentId);
    }

    it('should store and retrieve secrets by deployment ID', async () => {
      const manager = new SecretsManager();
      const deploymentId = 'test-deployment-123';
      createDeployment(deploymentId);

      const secrets = {
        dbPassword: 'super-secret',
        apiKey: 'api-key-value',
      };

      await manager.storeSecrets(deploymentId, secrets);
      const retrieved = await manager.getSecrets(deploymentId);

      expect(retrieved).toEqual(secrets);
    });

    it('should return null for non-existent deployment', async () => {
      const manager = new SecretsManager();
      const retrieved = await manager.getSecrets('non-existent-id');

      expect(retrieved).toBeNull();
    });

    it('should update existing secrets on conflict', async () => {
      const manager = new SecretsManager();
      const deploymentId = 'update-test';
      createDeployment(deploymentId);

      await manager.storeSecrets(deploymentId, { version: 1 });
      await manager.storeSecrets(deploymentId, { version: 2, newField: 'added' });

      const retrieved = await manager.getSecrets(deploymentId);
      expect(retrieved).toEqual({ version: 2, newField: 'added' });
    });

    it('should delete secrets', async () => {
      const manager = new SecretsManager();
      const deploymentId = 'delete-test';
      createDeployment(deploymentId);

      await manager.storeSecrets(deploymentId, { secret: 'value' });
      expect(await manager.getSecrets(deploymentId)).not.toBeNull();

      await manager.deleteSecrets(deploymentId);
      expect(await manager.getSecrets(deploymentId)).toBeNull();
    });

    it('should store secrets synchronously for transactions', () => {
      const manager = new SecretsManager();
      const deploymentId = 'sync-test';
      createDeployment(deploymentId);

      const secrets = { syncSecret: 'value' };

      manager.storeSecretsSync(deploymentId, secrets);

      // Verify directly in database
      const row = db.prepare('SELECT data FROM secrets WHERE deployment_id = ?').get(deploymentId) as { data: string };
      expect(row).toBeDefined();

      // Verify decryption works
      const decrypted = manager.decrypt(row.data);
      expect(decrypted).toEqual(secrets);
    });

    it('should delete secrets synchronously', () => {
      const manager = new SecretsManager();
      const deploymentId = 'sync-delete-test';
      createDeployment(deploymentId);

      manager.storeSecretsSync(deploymentId, { secret: 'value' });
      manager.deleteSecretsSync(deploymentId);

      const row = db.prepare('SELECT * FROM secrets WHERE deployment_id = ?').get(deploymentId);
      expect(row).toBeUndefined();
    });
  });

  describe('Service Credentials Retrieval', () => {
    // Helper to create required FK records
    function createDeployment(deploymentId: string) {
      db.prepare(`
        INSERT OR IGNORE INTO servers (id, name, host, is_core)
        VALUES ('test-server', 'Test Server', 'localhost', 0)
      `).run();

      db.prepare(`
        INSERT OR IGNORE INTO app_registry (name, manifest, system)
        VALUES ('test-app', '{}', 0)
      `).run();

      db.prepare(`
        INSERT OR REPLACE INTO deployments (id, server_id, app_name, version, config, status)
        VALUES (?, 'test-server', 'test-app', '1.0.0', '{}', 'running')
      `).run(deploymentId);
    }

    it('should retrieve specific credential fields', async () => {
      const manager = new SecretsManager();
      const deploymentId = 'creds-test';
      createDeployment(deploymentId);

      const secrets = {
        username: 'admin',
        password: 'secret',
        apiKey: 'key123',
        internalToken: 'token456',
      };

      await manager.storeSecrets(deploymentId, secrets);

      const credentials = await manager.getServiceCredentials(deploymentId, ['username', 'password']);

      expect(credentials).toEqual({
        username: 'admin',
        password: 'secret',
      });
    });

    it('should return null for non-existent deployment', async () => {
      const manager = new SecretsManager();
      const credentials = await manager.getServiceCredentials('non-existent', ['username']);

      expect(credentials).toBeNull();
    });

    it('should return null if no requested fields exist', async () => {
      const manager = new SecretsManager();
      const deploymentId = 'partial-test';
      createDeployment(deploymentId);

      await manager.storeSecrets(deploymentId, { existingField: 'value' });

      const credentials = await manager.getServiceCredentials(deploymentId, ['nonExistent', 'alsoMissing']);

      expect(credentials).toBeNull();
    });

    it('should return partial credentials if some fields exist', async () => {
      const manager = new SecretsManager();
      const deploymentId = 'partial-fields';
      createDeployment(deploymentId);

      await manager.storeSecrets(deploymentId, {
        username: 'admin',
        otherField: 'ignored',
      });

      const credentials = await manager.getServiceCredentials(deploymentId, ['username', 'password']);

      expect(credentials).toEqual({ username: 'admin' });
    });

    it('should convert non-string values to strings', async () => {
      const manager = new SecretsManager();
      const deploymentId = 'type-conversion';
      createDeployment(deploymentId);

      await manager.storeSecrets(deploymentId, {
        port: 5432,
        enabled: true,
        config: { nested: 'object' },
      });

      const credentials = await manager.getServiceCredentials(deploymentId, ['port', 'enabled', 'config']);

      expect(credentials).toEqual({
        port: '5432',
        enabled: 'true',
        config: '[object Object]',
      });
    });
  });

  describe('Configuration Validation', () => {
    it('should only initialize once', () => {
      const manager = new SecretsManager();

      manager.validateConfiguration();
      const firstEncrypt = manager.encrypt({ test: 1 });

      // Second call should be a no-op
      manager.validateConfiguration();
      const secondEncrypt = manager.encrypt({ test: 1 });

      // Both should work (not throw)
      expect(manager.decrypt(firstEncrypt)).toEqual({ test: 1 });
      expect(manager.decrypt(secondEncrypt)).toEqual({ test: 1 });
    });

    it('should auto-initialize when encrypting without explicit validation', () => {
      const manager = new SecretsManager();

      // Should work without calling validateConfiguration first
      const encrypted = manager.encrypt({ autoInit: true });
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toEqual({ autoInit: true });
    });

    it('should use consistent key after initialization', () => {
      const manager = new SecretsManager();

      // Encrypt multiple items
      const encrypted1 = manager.encrypt({ item: 1 });
      const encrypted2 = manager.encrypt({ item: 2 });

      // All should decrypt correctly (using same key)
      expect(manager.decrypt(encrypted1)).toEqual({ item: 1 });
      expect(manager.decrypt(encrypted2)).toEqual({ item: 2 });
    });
  });

  describe('Edge Cases', () => {
    it('should handle very large objects', () => {
      const manager = new SecretsManager();
      const largeObject: Record<string, string> = {};

      for (let i = 0; i < 1000; i++) {
        largeObject[`key${i}`] = 'x'.repeat(100);
      }

      const encrypted = manager.encrypt(largeObject);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toEqual(largeObject);
    });

    it('should handle deeply nested objects', () => {
      const manager = new SecretsManager();

      // Create deeply nested structure
      let nested: Record<string, unknown> = { value: 'deepest' };
      for (let i = 0; i < 50; i++) {
        nested = { level: i, child: nested };
      }

      const encrypted = manager.encrypt(nested);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toEqual(nested);
    });

    it('should handle arrays in objects', () => {
      const manager = new SecretsManager();
      const data = {
        items: [1, 2, 3, 'four', { five: 5 }],
        nested: {
          array: [[1, 2], [3, 4]],
        },
      };

      const encrypted = manager.encrypt(data);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toEqual(data);
    });

    it('should handle numeric values correctly', () => {
      const manager = new SecretsManager();
      const data = {
        integer: 42,
        float: 3.14159,
        negative: -100,
        zero: 0,
        scientific: 1e10,
      };

      const encrypted = manager.encrypt(data);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toEqual(data);
    });

    it('should handle boolean values correctly', () => {
      const manager = new SecretsManager();
      const data = {
        enabled: true,
        disabled: false,
      };

      const encrypted = manager.encrypt(data);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toEqual(data);
    });
  });
});
