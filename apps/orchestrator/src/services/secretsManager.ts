import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { secretsLogger } from '../lib/logger.js';
import { zeroBuffer, registerCleanup } from '../lib/secureBuffer.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const ENCRYPTION_SALT_KEY = 'encryption_salt';

export interface KeyValidationResult {
  valid: boolean;
  format: 'base64' | 'hex' | 'raw' | 'invalid';
  warning?: string;
  error?: string;
}

/**
 * Validate the format of a SECRETS_KEY.
 * Accepts:
 * - Base64 format: 44 characters that decode to 32 bytes
 * - Hex format: 64 hex characters (32 bytes)
 * - Raw string: 32+ characters (with warning about entropy)
 */
function validateKeyFormat(key: string): KeyValidationResult {
  if (!key || key.length === 0) {
    return { valid: false, format: 'invalid', error: 'Key is empty' };
  }

  // Check for Base64 format (44 chars including padding = 32 bytes)
  if (key.length === 44 && /^[A-Za-z0-9+/]+=*$/.test(key)) {
    try {
      const decoded = Buffer.from(key, 'base64');
      if (decoded.length === 32) {
        return { valid: true, format: 'base64' };
      }
    } catch {
      // Fall through to other formats
    }
  }

  // Check for Hex format (64 hex chars = 32 bytes)
  if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
    return { valid: true, format: 'hex' };
  }

  // Raw string format - must be at least 32 characters
  if (key.length >= 32) {
    // Check for low entropy indicators
    const hasLowercase = /[a-z]/.test(key);
    const hasUppercase = /[A-Z]/.test(key);
    const hasDigit = /[0-9]/.test(key);
    const hasSpecial = /[^a-zA-Z0-9]/.test(key);
    const charTypes = [hasLowercase, hasUppercase, hasDigit, hasSpecial].filter(Boolean).length;

    if (charTypes < 3) {
      return {
        valid: true,
        format: 'raw',
        warning: 'SECRETS_KEY has low entropy. Consider using: openssl rand -base64 32',
      };
    }
    return { valid: true, format: 'raw' };
  }

  return {
    valid: false,
    format: 'invalid',
    error: `SECRETS_KEY must be at least 32 characters. Got ${key.length} characters. ` +
      'Generate one with: openssl rand -base64 32',
  };
}

export class SecretsManager {
  private key: Buffer | null = null;
  private initialized: boolean = false;

  /**
   * Get or generate a unique salt for this installation.
   * The salt is stored in the database and persists across restarts.
   */
  private getOrCreateSalt(): Buffer {
    const db = getDb();

    // Try to get existing salt
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(ENCRYPTION_SALT_KEY) as { value: string } | undefined;

    if (row) {
      return Buffer.from(row.value, 'base64');
    }

    // Generate new salt for this installation
    const salt = randomBytes(SALT_LENGTH);
    const saltB64 = salt.toString('base64');

    db.prepare(`
      INSERT INTO system_settings (key, value, created_at, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(ENCRYPTION_SALT_KEY, saltB64);

    return salt;
  }

  /**
   * Validate secrets configuration at startup
   * Throws in production if SECRETS_KEY is not configured
   */
  validateConfiguration(): void {
    if (this.initialized) return;

    const secretsKey = config.secrets.key;

    if (!secretsKey) {
      if (config.isDevelopment) {
        secretsLogger.warn('No SECRETS_KEY configured. Using ephemeral key for development.');
        secretsLogger.warn('Secrets will NOT persist across restarts!');
        secretsLogger.warn('Set SECRETS_KEY environment variable for persistence.');
        // Generate a persistent key for this session
        this.key = randomBytes(32);
      } else {
        throw new Error(
          'SECRETS_KEY environment variable is required in production. ' +
          'Generate one with: openssl rand -base64 32'
        );
      }
    } else {
      // Validate key format
      const validation = validateKeyFormat(secretsKey);

      if (!validation.valid) {
        throw new Error(validation.error || 'Invalid SECRETS_KEY format');
      }

      if (validation.warning) {
        secretsLogger.warn(validation.warning);
      }

      secretsLogger.info({ format: validation.format }, 'SECRETS_KEY validated');

      // Derive a key using a unique salt for this installation
      const salt = this.getOrCreateSalt();
      this.key = scryptSync(secretsKey, salt, 32);
    }

    this.initialized = true;
  }

  private getKey(): Buffer {
    if (!this.initialized) {
      this.validateConfiguration();
    }

    if (!this.key) {
      throw new Error('Secrets manager not properly initialized');
    }

    return this.key;
  }

  encrypt(data: Record<string, unknown>): string {
    const key = this.getKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const plaintext = JSON.stringify(data);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    // Format: iv:tag:encrypted (all base64)
    return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  decrypt(encryptedData: string): Record<string, unknown> {
    const key = this.getKey();
    const [ivB64, tagB64, dataB64] = encryptedData.split(':');

    if (!ivB64 || !tagB64 || !dataB64) {
      throw new Error('Invalid encrypted data format');
    }

    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const encrypted = Buffer.from(dataB64, 'base64');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    try {
      return JSON.parse(decrypted.toString('utf8'));
    } finally {
      // Clear the decrypted buffer after parsing
      // This is defense-in-depth; the parsed object may still be in memory
      zeroBuffer(decrypted);
    }
  }

  /**
   * Clear the encryption key from memory.
   * Called during graceful shutdown.
   */
  clearKey(): void {
    if (this.key) {
      zeroBuffer(this.key);
      this.key = null;
      this.initialized = false;
      secretsLogger.debug('Encryption key cleared from memory');
    }
  }

  generatePassword(length: number = 32): string {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = randomBytes(length);
    let password = '';
    for (let i = 0; i < length; i++) {
      password += charset[bytes[i] % charset.length];
    }
    return password;
  }

  generateUsername(prefix: string = 'user'): string {
    return `${prefix}_${randomBytes(4).toString('hex')}`;
  }

  async storeSecrets(deploymentId: string, secrets: Record<string, unknown>): Promise<void> {
    this.storeSecretsSync(deploymentId, secrets);
  }

  /**
   * Synchronous version for use in transactions
   */
  storeSecretsSync(deploymentId: string, secrets: Record<string, unknown>): void {
    const db = getDb();
    const encrypted = this.encrypt(secrets);

    db.prepare(`
      INSERT INTO secrets (deployment_id, data, created_at, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(deployment_id) DO UPDATE SET
        data = excluded.data,
        updated_at = CURRENT_TIMESTAMP
    `).run(deploymentId, encrypted);
  }

  async getSecrets(deploymentId: string): Promise<Record<string, unknown> | null> {
    const db = getDb();
    const row = db.prepare('SELECT data FROM secrets WHERE deployment_id = ?').get(deploymentId) as { data: string } | undefined;

    if (!row) {
      return null;
    }

    return this.decrypt(row.data);
  }

  async deleteSecrets(deploymentId: string): Promise<void> {
    this.deleteSecretsSync(deploymentId);
  }

  /**
   * Synchronous version for use in transactions
   */
  deleteSecretsSync(deploymentId: string): void {
    const db = getDb();
    db.prepare('DELETE FROM secrets WHERE deployment_id = ?').run(deploymentId);
  }

  async getServiceCredentials(deploymentId: string, fields: string[]): Promise<Record<string, string> | null> {
    const secrets = await this.getSecrets(deploymentId);
    if (!secrets) {
      return null;
    }

    const credentials: Record<string, string> = {};
    for (const field of fields) {
      if (secrets[field] !== undefined) {
        credentials[field] = String(secrets[field]);
      }
    }

    return Object.keys(credentials).length > 0 ? credentials : null;
  }

  /**
   * Rotate the encryption key to a new key.
   * This re-encrypts all secrets with the new key.
   *
   * IMPORTANT: After rotation, the new key must be saved to the environment.
   * The old key will no longer work.
   *
   * @param newKey The new encryption key
   * @throws Error if rotation fails (transaction will be rolled back)
   */
  async rotateEncryptionKey(newKey: string): Promise<void> {
    // Validate new key format
    const validation = validateKeyFormat(newKey);
    if (!validation.valid) {
      throw new Error(`Invalid new key format: ${validation.error}`);
    }

    const db = getDb();
    const oldKey = this.key;

    if (!oldKey) {
      throw new Error('Secrets manager not initialized - cannot rotate key');
    }

    secretsLogger.info('Starting encryption key rotation');

    try {
      // Run in transaction so we can rollback on failure
      db.transaction(() => {
        // 1. Get all encrypted secrets
        const secrets = db.prepare('SELECT deployment_id, data FROM secrets').all() as { deployment_id: string; data: string }[];

        if (secrets.length === 0) {
          secretsLogger.info('No secrets to rotate');
        } else {
          secretsLogger.info({ count: secrets.length }, 'Rotating secrets');
        }

        // 2. Decrypt all secrets with old key
        const decrypted: { deploymentId: string; data: Record<string, unknown> }[] = [];
        for (const secret of secrets) {
          try {
            decrypted.push({
              deploymentId: secret.deployment_id,
              data: this.decrypt(secret.data),
            });
          } catch (err) {
            throw new Error(`Failed to decrypt secret for deployment ${secret.deployment_id}: ${err}`);
          }
        }

        // 3. Generate new salt
        const newSalt = randomBytes(SALT_LENGTH);
        const newSaltB64 = newSalt.toString('base64');

        // 4. Derive new key
        const newDerivedKey = scryptSync(newKey, newSalt, 32);

        // 5. Temporarily swap to new key for encryption
        this.key = newDerivedKey;

        // 6. Re-encrypt all secrets with new key
        for (const { deploymentId, data } of decrypted) {
          try {
            const encrypted = this.encrypt(data);
            db.prepare(`
              UPDATE secrets
              SET data = ?, updated_at = CURRENT_TIMESTAMP, rotated_at = CURRENT_TIMESTAMP
              WHERE deployment_id = ?
            `).run(encrypted, deploymentId);
          } catch (err) {
            // Restore old key before throwing
            this.key = oldKey;
            throw new Error(`Failed to re-encrypt secret for deployment ${deploymentId}: ${err}`);
          }
        }

        // 7. Update salt in system_settings
        db.prepare(`
          UPDATE system_settings
          SET value = ?, updated_at = CURRENT_TIMESTAMP
          WHERE key = ?
        `).run(newSaltB64, ENCRYPTION_SALT_KEY);

        // 8. Also rotate mount credentials if any
        const mountCreds = db.prepare('SELECT id, data FROM mount_credentials').all() as { id: string; data: string }[];
        if (mountCreds.length > 0) {
          // Need to decrypt with old key, re-encrypt with new
          this.key = oldKey;
          const decryptedMountCreds: { id: string; data: Record<string, unknown> }[] = [];
          for (const cred of mountCreds) {
            try {
              decryptedMountCreds.push({
                id: cred.id,
                data: this.decrypt(cred.data),
              });
            } catch (err) {
              throw new Error(`Failed to decrypt mount credentials ${cred.id}: ${err}`);
            }
          }

          // Re-encrypt with new key
          this.key = newDerivedKey;
          for (const { id, data } of decryptedMountCreds) {
            const encrypted = this.encrypt(data);
            db.prepare(`
              UPDATE mount_credentials
              SET data = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(encrypted, id);
          }
        }

        secretsLogger.info({ secretsRotated: secrets.length, mountCredsRotated: mountCreds.length }, 'Key rotation complete');
      })();

      // Clear old key from memory
      if (oldKey) {
        zeroBuffer(oldKey);
      }

    } catch (err) {
      // Restore old key on any error
      this.key = oldKey;
      secretsLogger.error({ err }, 'Key rotation failed - rolled back');
      throw new Error(`Key rotation failed: ${err}`);
    }
  }
}

export const secretsManager = new SecretsManager();

// Register cleanup to clear encryption key on process exit
registerCleanup(() => secretsManager.clearKey());
