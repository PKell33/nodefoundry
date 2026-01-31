import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { dbLogger } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

// Retry configuration for SQLITE_BUSY errors
const BUSY_RETRY_MAX_ATTEMPTS = 5;
const BUSY_RETRY_BASE_DELAY_MS = 50;
const BUSY_TIMEOUT_MS = 5000; // 5 seconds busy timeout

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(): Database.Database {
  const dbDir = dirname(config.database.path);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(config.database.path);

  // Set busy timeout to 5 seconds (default is 1 second)
  // This helps with concurrent access in WAL mode
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schemaPath = join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // Run migrations for schema changes
  runMigrations(db);

  dbLogger.info({ path: config.database.path }, 'Database initialized');
  return db;
}

/**
 * Run database migrations for schema changes.
 * Each migration is idempotent and checks if it needs to be applied.
 */
function runMigrations(database: Database.Database): void {
  // Migration 1: Add rotated_at column to secrets table
  const secretsColumns = database.prepare("PRAGMA table_info(secrets)").all() as { name: string }[];
  const hasRotatedAt = secretsColumns.some(col => col.name === 'rotated_at');
  if (!hasRotatedAt) {
    database.exec('ALTER TABLE secrets ADD COLUMN rotated_at TIMESTAMP');
    dbLogger.info('Migration: Added rotated_at column to secrets table');
  }

  // Migration 2: Add name and expires_at columns to agent_tokens table
  const agentTokensColumns = database.prepare("PRAGMA table_info(agent_tokens)").all() as { name: string }[];
  const hasTokenName = agentTokensColumns.some(col => col.name === 'name');
  if (!hasTokenName) {
    database.exec('ALTER TABLE agent_tokens ADD COLUMN name TEXT');
    dbLogger.info('Migration: Added name column to agent_tokens table');
  }
  const hasExpiresAt = agentTokensColumns.some(col => col.name === 'expires_at');
  if (!hasExpiresAt) {
    database.exec('ALTER TABLE agent_tokens ADD COLUMN expires_at TIMESTAMP');
    database.exec('CREATE INDEX IF NOT EXISTS idx_agent_tokens_expires ON agent_tokens(expires_at)');
    dbLogger.info('Migration: Added expires_at column to agent_tokens table');
  }

  // Migration 3: Add network_info column to servers table
  const serversColumns = database.prepare("PRAGMA table_info(servers)").all() as { name: string }[];
  const hasNetworkInfo = serversColumns.some(col => col.name === 'network_info');
  if (!hasNetworkInfo) {
    database.exec('ALTER TABLE servers ADD COLUMN network_info JSON');
    dbLogger.info('Migration: Added network_info column to servers table');
  }

  // Migration 4: Add system and mandatory columns to app_registry table
  const appRegistryColumns = database.prepare("PRAGMA table_info(app_registry)").all() as { name: string }[];
  const hasSystemFlag = appRegistryColumns.some(col => col.name === 'system');
  if (!hasSystemFlag) {
    database.exec('ALTER TABLE app_registry ADD COLUMN system BOOLEAN DEFAULT FALSE');
    dbLogger.info('Migration: Added system column to app_registry table');
  }
  const hasMandatoryFlag = appRegistryColumns.some(col => col.name === 'mandatory');
  if (!hasMandatoryFlag) {
    database.exec('ALTER TABLE app_registry ADD COLUMN mandatory BOOLEAN DEFAULT FALSE');
    dbLogger.info('Migration: Added mandatory column to app_registry table');
  }
  const hasSingletonFlag = appRegistryColumns.some(col => col.name === 'singleton');
  if (!hasSingletonFlag) {
    database.exec('ALTER TABLE app_registry ADD COLUMN singleton BOOLEAN DEFAULT FALSE');
    dbLogger.info('Migration: Added singleton column to app_registry table');
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Run a function within a database transaction.
 * If the function throws, the transaction is rolled back.
 * If the function succeeds, the transaction is committed.
 *
 * @param fn - The function to run within the transaction
 * @returns The return value of the function
 */
export function runInTransaction<T>(fn: () => T): T {
  const database = getDb();
  return database.transaction(fn)();
}

/**
 * Check if an error is a SQLITE_BUSY error.
 */
function isBusyError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes('SQLITE_BUSY') || error.message.includes('database is locked');
  }
  return false;
}

/**
 * Run a database operation with retry logic for SQLITE_BUSY errors.
 * Use this for critical operations that might fail under high concurrency.
 *
 * @param fn - The function to run (can be sync or async)
 * @param maxAttempts - Maximum number of retry attempts (default: 5)
 * @returns The return value of the function
 */
export async function withBusyRetry<T>(
  fn: () => T | Promise<T>,
  maxAttempts: number = BUSY_RETRY_MAX_ATTEMPTS
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (isBusyError(error) && attempt < maxAttempts) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Exponential backoff with jitter
        const delay = BUSY_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 50;
        dbLogger.warn({ attempt, maxAttempts, delay }, 'Database busy, retrying');
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }

  throw lastError || new Error('Database operation failed after retries');
}

/**
 * Synchronous version of withBusyRetry for use in sync contexts.
 * Note: Uses busy-wait instead of setTimeout.
 */
export function withBusyRetrySync<T>(
  fn: () => T,
  maxAttempts: number = BUSY_RETRY_MAX_ATTEMPTS
): T {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (isBusyError(error) && attempt < maxAttempts) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Synchronous delay using busy-wait (not ideal but necessary for sync)
        const delay = BUSY_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        const start = Date.now();
        while (Date.now() - start < delay) {
          // busy-wait
        }
        dbLogger.warn({ attempt, maxAttempts, delay }, 'Database busy (sync), retrying');
      } else {
        throw error;
      }
    }
  }

  throw lastError || new Error('Database operation failed after retries');
}
