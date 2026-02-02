/**
 * Base class for app store services
 * Provides common functionality for registry management, app caching, and syncing
 *
 * Uses unified tables:
 * - store_registries: All registries with store_type column
 * - store_app_cache: All cached apps with store_type column
 */

import { mkdir, writeFile, rm, readdir } from 'fs/promises';
import { createWriteStream, createReadStream, existsSync } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { Extract } from 'unzipper';
import { getDb } from '../db/index.js';
import { CountRow } from '../db/types.js';
import { update } from '../db/queryBuilder.js';
import logger from '../lib/logger.js';
import { config } from '../config.js';

/** Unified table names */
const REGISTRIES_TABLE = 'store_registries';
const APP_CACHE_TABLE = 'store_app_cache';

/** Track if unified tables have been created */
let tablesInitialized = false;

/**
 * Common registry interface used by all stores
 */
export interface StoreRegistry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  appCount?: number;
  lastSync?: string;
  createdAt: string;
}

/**
 * Base app definition with common fields
 */
export interface BaseAppDefinition {
  id: string;
  name: string;
  version: string;
  tagline: string;
  description: string;
  category: string;
  categories?: string[];
  developer: string;
  icon: string;
  port: number;
  registry: string;
}

/**
 * Sync result returned by syncApps
 */
export interface SyncResult {
  synced: number;
  updated: number;
  removed: number;
  errors: string[];
}

/**
 * Progress callback for sync operations
 */
export interface SyncProgressCallback {
  onProgress: (data: {
    registryId: string;
    registryName: string;
    phase: 'fetching' | 'processing' | 'complete';
    currentApp?: string;
    processed: number;
    total: number;
    errors: string[];
  }) => void;
}

/**
 * Default registry configuration
 */
export interface DefaultRegistry {
  id: string;
  name: string;
  url: string;
}

/**
 * Database row for app cache
 */
interface AppCacheRow {
  id: string;
  store_type: string;
  registry: string;
  data: string;
  updated_at: string;
}

/**
 * Database row for registry
 */
interface RegistryRow {
  id: string;
  store_type: string;
  name: string;
  url: string;
  enabled: number;
  last_sync: string | null;
  created_at: string;
}

/**
 * Initialize unified tables (called once across all store services)
 */
function initializeUnifiedTables(): void {
  if (tablesInitialized) return;

  const db = getDb();

  // Create unified registries table
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${REGISTRIES_TABLE} (
      id TEXT NOT NULL,
      store_type TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_sync TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id, store_type),
      UNIQUE (url, store_type)
    )
  `);

  // Create unified app cache table
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${APP_CACHE_TABLE} (
      id TEXT NOT NULL,
      store_type TEXT NOT NULL,
      registry TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id, store_type, registry)
    )
  `);

  // Create indexes for common queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_store_registries_type ON ${REGISTRIES_TABLE}(store_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_store_app_cache_type ON ${APP_CACHE_TABLE}(store_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_store_app_cache_registry ON ${APP_CACHE_TABLE}(store_type, registry)`);

  tablesInitialized = true;
  logger.info('Unified store tables initialized');
}

/**
 * Abstract base class for app store services
 * Subclasses must implement the abstract methods for store-specific logic
 */
export abstract class BaseStoreService<TApp extends BaseAppDefinition> {
  protected initialized = false;

  /** Unique identifier for this store (e.g., 'umbrel', 'start9') */
  protected abstract readonly storeName: string;

  /** Default registries to seed on first run */
  protected abstract readonly defaultRegistries: DefaultRegistry[];

  /** Logger instance */
  protected readonly log = logger;

  // ==================== Abstract Methods (Store-Specific) ====================

  /**
   * Fetch all apps from a registry
   * @param registry The registry to fetch from
   * @returns Array of app data with id and version for comparison
   */
  protected abstract fetchAppsFromRegistry(registry: StoreRegistry): Promise<Array<{ id: string; version: string; data: unknown }>>;

  /**
   * Transform raw app data into the store's app definition format
   * @param appId The app ID
   * @param registryId The registry ID
   * @param rawData The raw data fetched from the registry
   * @returns The normalized app definition
   */
  protected abstract transformApp(appId: string, registryId: string, rawData: unknown): TApp;

  /**
   * Download and save an app's icon
   * @param appId The app ID
   * @param registryId The registry ID
   * @param rawData The raw data (may contain icon URL or data)
   * @returns true if icon was downloaded, false if missing/failed
   */
  protected abstract downloadIcon(appId: string, registryId: string, rawData: unknown): Promise<boolean>;

  /**
   * Validate a registry URL
   * @param url The URL to validate
   * @throws Error if URL is invalid
   */
  protected abstract validateRegistryUrl(url: string): void;

  // ==================== Initialization ====================

  /**
   * Initialize the store - create tables and seed defaults
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize unified tables (only happens once)
    initializeUnifiedTables();

    const db = getDb();

    // Seed default registries if none exist for this store
    const registryCount = db.prepare(
      `SELECT COUNT(*) as count FROM ${REGISTRIES_TABLE} WHERE store_type = ?`
    ).get(this.storeName) as CountRow;

    if (registryCount.count === 0) {
      const insertStmt = db.prepare(
        `INSERT INTO ${REGISTRIES_TABLE} (id, store_type, name, url, enabled) VALUES (?, ?, ?, ?, 1)`
      );
      for (const reg of this.defaultRegistries) {
        insertStmt.run(reg.id, this.storeName, reg.name, reg.url);
      }
      this.log.info({ store: this.storeName, count: this.defaultRegistries.length }, 'Seeded default registries');
    }

    this.initialized = true;
    this.log.info({ store: this.storeName }, 'Store service initialized');
  }

  // ==================== Registry Management ====================

  /**
   * Get all registries
   */
  async getRegistries(): Promise<StoreRegistry[]> {
    await this.initialize();
    const db = getDb();

    const rows = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM ${APP_CACHE_TABLE} WHERE store_type = r.store_type AND registry = r.id) as app_count
      FROM ${REGISTRIES_TABLE} r
      WHERE r.store_type = ?
      ORDER BY r.created_at ASC
    `).all(this.storeName) as Array<RegistryRow & { app_count: number }>;

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      url: row.url,
      enabled: row.enabled === 1,
      appCount: row.app_count,
      lastSync: row.last_sync || undefined,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get a single registry by ID
   */
  async getRegistry(id: string): Promise<StoreRegistry | null> {
    await this.initialize();
    const db = getDb();

    const row = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM ${APP_CACHE_TABLE} WHERE store_type = r.store_type AND registry = r.id) as app_count
      FROM ${REGISTRIES_TABLE} r
      WHERE r.id = ? AND r.store_type = ?
    `).get(id, this.storeName) as (RegistryRow & { app_count: number }) | undefined;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      url: row.url,
      enabled: row.enabled === 1,
      appCount: row.app_count,
      lastSync: row.last_sync || undefined,
      createdAt: row.created_at,
    };
  }

  /**
   * Add a new registry
   */
  async addRegistry(id: string, name: string, url: string): Promise<StoreRegistry> {
    await this.initialize();
    const db = getDb();

    // Validate URL
    this.validateRegistryUrl(url);

    // Check for duplicate URL within this store
    const existingUrl = db.prepare(
      `SELECT id FROM ${REGISTRIES_TABLE} WHERE url = ? AND store_type = ?`
    ).get(url, this.storeName);
    if (existingUrl) {
      throw new Error('A registry with this URL already exists');
    }

    // Check for duplicate ID within this store
    const existingId = db.prepare(
      `SELECT id FROM ${REGISTRIES_TABLE} WHERE id = ? AND store_type = ?`
    ).get(id, this.storeName);
    if (existingId) {
      throw new Error('A registry with this ID already exists');
    }

    db.prepare(
      `INSERT INTO ${REGISTRIES_TABLE} (id, store_type, name, url, enabled) VALUES (?, ?, ?, ?, 1)`
    ).run(id, this.storeName, name, url);

    this.log.info({ store: this.storeName, id, name, url }, 'Added registry');

    return {
      id,
      name,
      url,
      enabled: true,
      appCount: 0,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Update a registry
   */
  async updateRegistry(id: string, updates: { name?: string; url?: string; enabled?: boolean }): Promise<StoreRegistry | null> {
    await this.initialize();
    const db = getDb();

    const existing = await this.getRegistry(id);
    if (!existing) return null;

    // Check for duplicate URL if updating
    if (updates.url !== undefined) {
      this.validateRegistryUrl(updates.url);

      const duplicate = db.prepare(
        `SELECT id FROM ${REGISTRIES_TABLE} WHERE url = ? AND id != ? AND store_type = ?`
      ).get(updates.url, id, this.storeName);
      if (duplicate) {
        throw new Error('A registry with this URL already exists');
      }
    }

    // Build UPDATE using UpdateBuilder
    const { setClause, params, hasUpdates } = update()
      .set('name', updates.name)
      .set('url', updates.url)
      .set('enabled', updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : undefined)
      .build();

    if (!hasUpdates) {
      return existing;
    }

    db.prepare(
      `UPDATE ${REGISTRIES_TABLE} SET ${setClause} WHERE id = ? AND store_type = ?`
    ).run(...params, id, this.storeName);

    this.log.info({ store: this.storeName, id, updates }, 'Updated registry');

    return this.getRegistry(id);
  }

  /**
   * Remove a registry and its cached apps
   */
  async removeRegistry(id: string): Promise<boolean> {
    await this.initialize();
    const db = getDb();

    const existing = db.prepare(
      `SELECT id FROM ${REGISTRIES_TABLE} WHERE id = ? AND store_type = ?`
    ).get(id, this.storeName);
    if (!existing) return false;

    // Delete cached apps for this registry
    db.prepare(
      `DELETE FROM ${APP_CACHE_TABLE} WHERE registry = ? AND store_type = ?`
    ).run(id, this.storeName);

    // Delete the registry
    db.prepare(
      `DELETE FROM ${REGISTRIES_TABLE} WHERE id = ? AND store_type = ?`
    ).run(id, this.storeName);

    this.log.info({ store: this.storeName, id }, 'Removed registry');

    return true;
  }

  // ==================== App Management ====================

  /**
   * Get all cached apps
   */
  async getApps(): Promise<TApp[]> {
    await this.initialize();
    const db = getDb();

    const rows = db.prepare(
      `SELECT * FROM ${APP_CACHE_TABLE} WHERE store_type = ?`
    ).all(this.storeName) as AppCacheRow[];
    return rows.map(row => this.rowToApp(row));
  }

  /**
   * Get a single app by ID
   * If registryId is provided, returns the specific registry's version
   * Otherwise returns the first match
   */
  async getApp(id: string, registryId?: string): Promise<TApp | null> {
    await this.initialize();
    const db = getDb();

    let row: AppCacheRow | undefined;
    if (registryId) {
      row = db.prepare(
        `SELECT * FROM ${APP_CACHE_TABLE} WHERE id = ? AND registry = ? AND store_type = ?`
      ).get(id, registryId, this.storeName) as AppCacheRow | undefined;
    } else {
      row = db.prepare(
        `SELECT * FROM ${APP_CACHE_TABLE} WHERE id = ? AND store_type = ?`
      ).get(id, this.storeName) as AppCacheRow | undefined;
    }

    if (!row) return null;
    return this.rowToApp(row);
  }

  /**
   * Get app count
   */
  async getAppCount(): Promise<number> {
    await this.initialize();
    const db = getDb();

    const result = db.prepare(
      `SELECT COUNT(*) as count FROM ${APP_CACHE_TABLE} WHERE store_type = ?`
    ).get(this.storeName) as CountRow;
    return result.count;
  }

  /**
   * Check if apps need to be synced (older than 1 hour)
   */
  async needsSync(): Promise<boolean> {
    await this.initialize();

    const registries = await this.getRegistries();

    for (const registry of registries) {
      if (!registry.enabled) continue;
      if (!registry.lastSync) return true;

      const lastSync = new Date(registry.lastSync);
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (lastSync < oneHourAgo) return true;
    }

    return false;
  }

  /**
   * Convert database row to app definition
   */
  protected rowToApp(row: AppCacheRow): TApp {
    return JSON.parse(row.data) as TApp;
  }

  // ==================== Sync ====================

  /**
   * Sync apps from registries
   * @param registryId Optional - sync only this registry
   * @param progressCallback Optional - callback for progress updates
   */
  async syncApps(registryId?: string, progressCallback?: SyncProgressCallback): Promise<SyncResult> {
    await this.initialize();

    const db = getDb();
    let synced = 0;
    let updated = 0;
    let removed = 0;
    const errors: string[] = [];
    const syncedAppIds = new Map<string, Set<string>>();

    // Get registries to sync
    let registriesToSync: StoreRegistry[];
    if (registryId) {
      const registry = await this.getRegistry(registryId);
      if (!registry) {
        throw new Error(`Registry not found: ${registryId}`);
      }
      if (!registry.enabled) {
        throw new Error(`Registry is disabled: ${registryId}`);
      }
      registriesToSync = [registry];
    } else {
      registriesToSync = (await this.getRegistries()).filter(r => r.enabled);
    }

    for (const registry of registriesToSync) {
      syncedAppIds.set(registry.id, new Set());
      let processed = 0;

      try {
        this.log.info({ store: this.storeName, registry: registry.name, url: registry.url }, 'Syncing registry');

        // Emit fetching phase
        progressCallback?.onProgress({
          registryId: registry.id,
          registryName: registry.name,
          phase: 'fetching',
          processed: 0,
          total: 0,
          errors: [],
        });

        // Fetch all apps from registry (store-specific implementation)
        const fetchedApps = await this.fetchAppsFromRegistry(registry);
        this.log.info({ store: this.storeName, registry: registry.name, count: fetchedApps.length }, 'Fetched apps');

        const total = fetchedApps.length;

        // Process each app
        for (const fetchedApp of fetchedApps) {
          try {
            // Emit processing progress
            progressCallback?.onProgress({
              registryId: registry.id,
              registryName: registry.name,
              phase: 'processing',
              currentApp: fetchedApp.id,
              processed,
              total,
              errors: [...errors],
            });

            // Check if app exists and get its version
            const existing = db.prepare(
              `SELECT id, data FROM ${APP_CACHE_TABLE} WHERE id = ? AND registry = ? AND store_type = ?`
            ).get(fetchedApp.id, registry.id, this.storeName) as { id: string; data: string } | undefined;

            // Download icon (store-specific implementation)
            const iconDownloaded = await this.downloadIcon(fetchedApp.id, registry.id, fetchedApp.data).catch(err => {
              this.log.warn({ store: this.storeName, appId: fetchedApp.id, error: err }, 'Failed to download icon');
              return false;
            });
            if (iconDownloaded === false) {
              errors.push(`Icon missing: ${fetchedApp.id}`);
            }

            // Transform and cache the app
            const app = this.transformApp(fetchedApp.id, registry.id, fetchedApp.data);

            db.prepare(`
              INSERT OR REPLACE INTO ${APP_CACHE_TABLE} (id, store_type, registry, data, updated_at)
              VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(fetchedApp.id, this.storeName, registry.id, JSON.stringify(app));

            syncedAppIds.get(registry.id)!.add(fetchedApp.id);

            if (existing) {
              const oldApp = JSON.parse(existing.data) as TApp;
              if (oldApp.version !== fetchedApp.version) {
                updated++;
              }
            } else {
              synced++;
            }

            processed++;
          } catch (err) {
            const msg = `Failed to process ${fetchedApp.id}: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
            this.log.warn({ store: this.storeName, appId: fetchedApp.id, registry: registry.id, error: err }, msg);
            processed++;
          }
        }

        // Emit registry complete
        progressCallback?.onProgress({
          registryId: registry.id,
          registryName: registry.name,
          phase: 'complete',
          processed: total,
          total,
          errors: [...errors],
        });

        // Update registry last_sync time
        db.prepare(
          `UPDATE ${REGISTRIES_TABLE} SET last_sync = CURRENT_TIMESTAMP WHERE id = ? AND store_type = ?`
        ).run(registry.id, this.storeName);

      } catch (err) {
        const msg = `Failed to sync ${registry.name}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        this.log.error({ store: this.storeName, registry: registry.id, error: err }, msg);

        // Emit error in progress
        progressCallback?.onProgress({
          registryId: registry.id,
          registryName: registry.name,
          phase: 'complete',
          processed: 0,
          total: 0,
          errors: [...errors],
        });
      }
    }

    // Remove apps no longer in synced registries
    for (const registry of registriesToSync) {
      const syncedIds = syncedAppIds.get(registry.id)!;
      const cachedApps = db.prepare(
        `SELECT id FROM ${APP_CACHE_TABLE} WHERE registry = ? AND store_type = ?`
      ).all(registry.id, this.storeName) as { id: string }[];

      for (const cached of cachedApps) {
        if (!syncedIds.has(cached.id)) {
          db.prepare(
            `DELETE FROM ${APP_CACHE_TABLE} WHERE id = ? AND registry = ? AND store_type = ?`
          ).run(cached.id, registry.id, this.storeName);
          removed++;
        }
      }
    }

    this.log.info({ store: this.storeName, synced, updated, removed, errors: errors.length }, 'Sync complete');
    return { synced, updated, removed, errors };
  }

  // ==================== ZIP Download Helper ====================

  /**
   * Download and extract a ZIP file from a URL.
   * Common logic used by CasaOS and Runtipi stores.
   *
   * @param url URL to download the ZIP from
   * @param appsDirName Name of the apps directory inside the repo (e.g., 'Apps', 'apps')
   * @returns Object with appsDir path and cleanup function
   */
  protected async downloadAndExtractZip(url: string, appsDirName: string): Promise<{ appsDir: string; cleanup: () => Promise<void> }> {
    const tempDir = join(config.paths.data, 'tmp', `${this.storeName}-${Date.now()}`);

    // Create temp directory
    await mkdir(tempDir, { recursive: true });
    const zipPath = join(tempDir, 'store.zip');

    // Download ZIP file
    const response = await fetch(url);
    if (!response.ok) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Failed to download registry: ${response.status}`);
    }

    const fileStream = createWriteStream(zipPath);
    // @ts-expect-error - Node.js stream compatibility
    await pipeline(response.body, fileStream);

    // Extract ZIP
    await new Promise<void>((resolve, reject) => {
      createReadStream(zipPath)
        .pipe(Extract({ path: tempDir }))
        .on('close', resolve)
        .on('error', reject);
    });

    // Find the extracted repo directory (first non-zip, non-hidden directory)
    const extractedDirs = await readdir(tempDir);
    const repoDir = extractedDirs.find(d => d !== 'store.zip' && !d.startsWith('.'));
    if (!repoDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw new Error('Could not find extracted repository directory');
    }

    // Find the apps directory
    const appsDir = join(tempDir, repoDir, appsDirName);
    if (!existsSync(appsDir)) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`${appsDirName} directory not found in registry`);
    }

    // Return apps directory and cleanup function
    return {
      appsDir,
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  // ==================== Icon Helpers ====================

  /**
   * Get the icon directory path for a registry
   */
  protected getIconDir(registryId: string): string {
    return join(config.paths.icons, this.storeName, registryId);
  }

  /**
   * Ensure icon directory exists
   */
  protected async ensureIconDir(registryId: string): Promise<string> {
    const dir = this.getIconDir(registryId);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Save icon data to file
   */
  protected async saveIcon(registryId: string, appId: string, data: Buffer, extension: string = 'png'): Promise<string> {
    const dir = await this.ensureIconDir(registryId);
    const iconPath = join(dir, `${appId}.${extension}`);
    await writeFile(iconPath, data);
    return iconPath;
  }

  /**
   * Get the API URL for an app's icon
   */
  protected getIconUrl(appId: string, registryId: string): string {
    return `/api/${this.storeName}/apps/${registryId}/${appId}/icon`;
  }
}
