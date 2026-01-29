import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { getDb } from '../db/index.js';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const ENCRYPTION_SALT_KEY = 'encryption_salt';

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
        console.warn('WARNING: No SECRETS_KEY configured. Using ephemeral key for development.');
        console.warn('         Secrets will NOT persist across restarts!');
        console.warn('         Set SECRETS_KEY environment variable for persistence.');
        // Generate a persistent key for this session
        this.key = randomBytes(32);
      } else {
        throw new Error(
          'SECRETS_KEY environment variable is required in production. ' +
          'Generate one with: openssl rand -base64 32'
        );
      }
    } else {
      if (secretsKey.length < 32) {
        throw new Error('SECRETS_KEY must be at least 32 characters long');
      }
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

    return JSON.parse(decrypted.toString('utf8'));
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
}

export const secretsManager = new SecretsManager();
