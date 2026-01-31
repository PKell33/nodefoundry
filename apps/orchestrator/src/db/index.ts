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

  // Initialize schema_migrations table for tracking applied migrations
  initMigrationTracking(db);

  // Run migrations for schema changes
  runMigrations(db);

  dbLogger.info({ path: config.database.path }, 'Database initialized');
  return db;
}

/**
 * Initialize the schema_migrations table for tracking applied migrations.
 */
function initMigrationTracking(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Check if a migration has been applied.
 */
function isMigrationApplied(database: Database.Database, version: number): boolean {
  const row = database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version);
  return !!row;
}

/**
 * Record a migration as applied.
 */
function recordMigration(database: Database.Database, version: number, name: string): void {
  database.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, name);
}

/**
 * Run database migrations for schema changes.
 * Uses version tracking to skip already-applied migrations.
 */
function runMigrations(database: Database.Database): void {
  // Migration 1: Add rotated_at column to secrets table
  if (!isMigrationApplied(database, 1)) {
    const secretsColumns = database.prepare("PRAGMA table_info(secrets)").all() as { name: string }[];
    const hasRotatedAt = secretsColumns.some(col => col.name === 'rotated_at');
    if (!hasRotatedAt) {
      database.exec('ALTER TABLE secrets ADD COLUMN rotated_at TIMESTAMP');
    }
    recordMigration(database, 1, 'add_rotated_at_to_secrets');
    dbLogger.info('Migration 1: Added rotated_at column to secrets table');
  }

  // Migration 2: Add name and expires_at columns to agent_tokens table
  if (!isMigrationApplied(database, 2)) {
    const agentTokensColumns = database.prepare("PRAGMA table_info(agent_tokens)").all() as { name: string }[];
    const hasTokenName = agentTokensColumns.some(col => col.name === 'name');
    if (!hasTokenName) {
      database.exec('ALTER TABLE agent_tokens ADD COLUMN name TEXT');
    }
    const hasExpiresAt = agentTokensColumns.some(col => col.name === 'expires_at');
    if (!hasExpiresAt) {
      database.exec('ALTER TABLE agent_tokens ADD COLUMN expires_at TIMESTAMP');
      database.exec('CREATE INDEX IF NOT EXISTS idx_agent_tokens_expires ON agent_tokens(expires_at)');
    }
    recordMigration(database, 2, 'add_name_expires_to_agent_tokens');
    dbLogger.info('Migration 2: Added name and expires_at columns to agent_tokens table');
  }

  // Migration 3: Add network_info column to servers table
  if (!isMigrationApplied(database, 3)) {
    const serversColumns = database.prepare("PRAGMA table_info(servers)").all() as { name: string }[];
    const hasNetworkInfo = serversColumns.some(col => col.name === 'network_info');
    if (!hasNetworkInfo) {
      database.exec('ALTER TABLE servers ADD COLUMN network_info JSON');
    }
    recordMigration(database, 3, 'add_network_info_to_servers');
    dbLogger.info('Migration 3: Added network_info column to servers table');
  }

  // Migration 4: Add system, mandatory, singleton columns to app_registry table
  if (!isMigrationApplied(database, 4)) {
    const appRegistryColumns = database.prepare("PRAGMA table_info(app_registry)").all() as { name: string }[];
    const hasSystemFlag = appRegistryColumns.some(col => col.name === 'system');
    if (!hasSystemFlag) {
      database.exec('ALTER TABLE app_registry ADD COLUMN system BOOLEAN DEFAULT FALSE');
    }
    const hasMandatoryFlag = appRegistryColumns.some(col => col.name === 'mandatory');
    if (!hasMandatoryFlag) {
      database.exec('ALTER TABLE app_registry ADD COLUMN mandatory BOOLEAN DEFAULT FALSE');
    }
    const hasSingletonFlag = appRegistryColumns.some(col => col.name === 'singleton');
    if (!hasSingletonFlag) {
      database.exec('ALTER TABLE app_registry ADD COLUMN singleton BOOLEAN DEFAULT FALSE');
    }
    recordMigration(database, 4, 'add_flags_to_app_registry');
    dbLogger.info('Migration 4: Added system/mandatory/singleton columns to app_registry table');
  }

  // Migration 5: Add used_backup_codes table for atomic backup code usage
  if (!isMigrationApplied(database, 5)) {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='used_backup_codes'").get();
    if (!tables) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS used_backup_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          code_hash TEXT NOT NULL,
          used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, code_hash)
        )
      `);
      database.exec('CREATE INDEX IF NOT EXISTS idx_used_backup_codes_user ON used_backup_codes(user_id)');
    }
    recordMigration(database, 5, 'add_used_backup_codes_table');
    dbLogger.info('Migration 5: Added used_backup_codes table');
  }

  // Migration 6: Add family_id and issued_at columns to refresh_tokens for token rotation
  if (!isMigrationApplied(database, 6)) {
    const refreshTokensColumns = database.prepare("PRAGMA table_info(refresh_tokens)").all() as { name: string }[];
    const hasFamilyId = refreshTokensColumns.some(col => col.name === 'family_id');
    if (!hasFamilyId) {
      database.exec('ALTER TABLE refresh_tokens ADD COLUMN family_id TEXT');
      database.exec('ALTER TABLE refresh_tokens ADD COLUMN issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
      database.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id)');
      // Set family_id to id for existing tokens (each becomes its own family)
      database.exec('UPDATE refresh_tokens SET family_id = id WHERE family_id IS NULL');
    }
    recordMigration(database, 6, 'add_family_id_to_refresh_tokens');
    dbLogger.info('Migration 6: Added family_id and issued_at columns to refresh_tokens table');
  }

  // Migration 7: Add foreign key constraints to command_log table
  if (!isMigrationApplied(database, 7)) {
    const hasCommandLogFk = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='command_log'
    `).get() as { sql: string } | undefined;

    // Check if FK constraint already exists by examining table schema
    if (hasCommandLogFk && !hasCommandLogFk.sql.includes('REFERENCES servers')) {
      dbLogger.info('Migration 7: Adding foreign key constraints to command_log table');

      // Create new table with FK constraints
      database.exec(`
        CREATE TABLE IF NOT EXISTS command_log_new (
          id TEXT PRIMARY KEY,
          server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          deployment_id TEXT REFERENCES deployments(id) ON DELETE CASCADE,
          action TEXT NOT NULL,
          payload JSON,
          status TEXT,
          result_message TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP
        )
      `);

      // Copy data from old table
      database.exec(`
        INSERT INTO command_log_new (id, server_id, deployment_id, action, payload, status, result_message, created_at, completed_at)
        SELECT id, server_id, deployment_id, action, payload, status, result_message, created_at, completed_at
        FROM command_log
        WHERE server_id IN (SELECT id FROM servers)
          AND (deployment_id IS NULL OR deployment_id IN (SELECT id FROM deployments))
      `);

      // Drop old table and rename new one
      database.exec('DROP TABLE command_log');
      database.exec('ALTER TABLE command_log_new RENAME TO command_log');

      // Recreate indexes
      database.exec('CREATE INDEX IF NOT EXISTS idx_command_log_status ON command_log(status)');
      database.exec('CREATE INDEX IF NOT EXISTS idx_command_log_deployment ON command_log(deployment_id)');
      database.exec('CREATE INDEX IF NOT EXISTS idx_command_log_server ON command_log(server_id)');
    }
    recordMigration(database, 7, 'add_fk_to_command_log');
    dbLogger.info('Migration 7: Completed adding foreign key constraints to command_log table');
  }

  // Migration 8: Add ON DELETE CASCADE to services.server_id foreign key
  if (!isMigrationApplied(database, 8)) {
    const servicesSchema = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='services'
    `).get() as { sql: string } | undefined;

    // Check if CASCADE already exists on server_id FK
    if (servicesSchema && servicesSchema.sql.includes('REFERENCES servers(id)') &&
        !servicesSchema.sql.includes('server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE')) {
      dbLogger.info('Migration 8: Adding ON DELETE CASCADE to services.server_id');

      // Create new table with proper FK constraint
      database.exec(`
        CREATE TABLE IF NOT EXISTS services_new (
          id TEXT PRIMARY KEY,
          deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
          service_name TEXT NOT NULL,
          server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          host TEXT NOT NULL,
          port INTEGER NOT NULL,
          tor_address TEXT,
          status TEXT DEFAULT 'available',
          UNIQUE(deployment_id, service_name)
        )
      `);

      // Copy data from old table (only rows with valid server_id)
      database.exec(`
        INSERT INTO services_new (id, deployment_id, service_name, server_id, host, port, tor_address, status)
        SELECT id, deployment_id, service_name, server_id, host, port, tor_address, status
        FROM services
        WHERE server_id IN (SELECT id FROM servers)
      `);

      // Drop old table and rename new one
      database.exec('DROP TABLE services');
      database.exec('ALTER TABLE services_new RENAME TO services');

      // Recreate indexes
      database.exec('CREATE INDEX IF NOT EXISTS idx_services_name ON services(service_name)');
      database.exec('CREATE INDEX IF NOT EXISTS idx_services_deployment ON services(deployment_id)');
    }
    recordMigration(database, 8, 'add_cascade_to_services_server_id');
    dbLogger.info('Migration 8: Completed adding ON DELETE CASCADE to services.server_id');
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
 * Relies on SQLite's busy_timeout pragma for delays, avoiding CPU-burning busy-wait.
 *
 * The busy_timeout pragma (set to 5 seconds) handles waiting internally,
 * so we just need to retry the operation a few times if it still fails.
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
        // SQLite's busy_timeout pragma handles the wait internally.
        // We just log and retry immediately - the pragma already waited.
        dbLogger.warn({ attempt, maxAttempts }, 'Database busy (sync), retrying');
      } else {
        throw error;
      }
    }
  }

  throw lastError || new Error('Database operation failed after retries');
}
