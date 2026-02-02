/**
 * Base class for app store services
 * Provides common functionality for registry management, app caching, and syncing
 */

import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/index.js';
import logger from '../lib/logger.js';
import { config } from '../config.js';

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
  registry: string;
  data: string;
  updated_at: string;
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
   */
  protected abstract downloadIcon(appId: string, registryId: string, rawData: unknown): Promise<void>;

  /**
   * Validate a registry URL
   * @param url The URL to validate
   * @throws Error if URL is invalid
   */
  protected abstract validateRegistryUrl(url: string): void;

  // ==================== Database Table Names ====================

  protected get registriesTable(): string {
    return `${this.storeName}_registries`;
  }

  protected get appCacheTable(): string {
    return `${this.storeName}_app_cache`;
  }

  // ==================== Initialization ====================

  /**
   * Initialize the store - create tables and seed defaults
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = getDb();

    // Create registries table
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.registriesTable} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_sync TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create app cache table with composite primary key
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.appCacheTable} (
        id TEXT NOT NULL,
        registry TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, registry)
      )
    `);

    // Seed default registries if none exist
    const registryCount = db.prepare(`SELECT COUNT(*) as count FROM ${this.registriesTable}`).get() as { count: number };
    if (registryCount.count === 0) {
      const insertStmt = db.prepare(`INSERT INTO ${this.registriesTable} (id, name, url, enabled) VALUES (?, ?, ?, 1)`);
      for (const reg of this.defaultRegistries) {
        insertStmt.run(reg.id, reg.name, reg.url);
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
        (SELECT COUNT(*) FROM ${this.appCacheTable} WHERE registry = r.id) as app_count
      FROM ${this.registriesTable} r
      ORDER BY r.created_at ASC
    `).all() as Array<{
      id: string;
      name: string;
      url: string;
      enabled: number;
      last_sync: string | null;
      created_at: string;
      app_count: number;
    }>;

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
        (SELECT COUNT(*) FROM ${this.appCacheTable} WHERE registry = r.id) as app_count
      FROM ${this.registriesTable} r
      WHERE r.id = ?
    `).get(id) as {
      id: string;
      name: string;
      url: string;
      enabled: number;
      last_sync: string | null;
      created_at: string;
      app_count: number;
    } | undefined;

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

    // Check for duplicate URL
    const existingUrl = db.prepare(`SELECT id FROM ${this.registriesTable} WHERE url = ?`).get(url);
    if (existingUrl) {
      throw new Error('A registry with this URL already exists');
    }

    // Check for duplicate ID
    const existingId = db.prepare(`SELECT id FROM ${this.registriesTable} WHERE id = ?`).get(id);
    if (existingId) {
      throw new Error('A registry with this ID already exists');
    }

    db.prepare(`INSERT INTO ${this.registriesTable} (id, name, url, enabled) VALUES (?, ?, ?, 1)`)
      .run(id, name, url);

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

    const fields: string[] = [];
    const values: (string | number)[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }

    if (updates.url !== undefined) {
      this.validateRegistryUrl(updates.url);

      const duplicate = db.prepare(`SELECT id FROM ${this.registriesTable} WHERE url = ? AND id != ?`).get(updates.url, id);
      if (duplicate) {
        throw new Error('A registry with this URL already exists');
      }

      fields.push('url = ?');
      values.push(updates.url);
    }

    if (updates.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }

    if (fields.length === 0) {
      return existing;
    }

    values.push(id);
    db.prepare(`UPDATE ${this.registriesTable} SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    this.log.info({ store: this.storeName, id, updates }, 'Updated registry');

    return this.getRegistry(id);
  }

  /**
   * Remove a registry and its cached apps
   */
  async removeRegistry(id: string): Promise<boolean> {
    await this.initialize();
    const db = getDb();

    const existing = db.prepare(`SELECT id FROM ${this.registriesTable} WHERE id = ?`).get(id);
    if (!existing) return false;

    // Delete cached apps for this registry
    db.prepare(`DELETE FROM ${this.appCacheTable} WHERE registry = ?`).run(id);

    // Delete the registry
    db.prepare(`DELETE FROM ${this.registriesTable} WHERE id = ?`).run(id);

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

    const rows = db.prepare(`SELECT * FROM ${this.appCacheTable}`).all() as AppCacheRow[];
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
      row = db.prepare(`SELECT * FROM ${this.appCacheTable} WHERE id = ? AND registry = ?`).get(id, registryId) as AppCacheRow | undefined;
    } else {
      row = db.prepare(`SELECT * FROM ${this.appCacheTable} WHERE id = ?`).get(id) as AppCacheRow | undefined;
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

    const result = db.prepare(`SELECT COUNT(*) as count FROM ${this.appCacheTable}`).get() as { count: number };
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
   */
  async syncApps(registryId?: string): Promise<SyncResult> {
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

      try {
        this.log.info({ store: this.storeName, registry: registry.name, url: registry.url }, 'Syncing registry');

        // Fetch all apps from registry (store-specific implementation)
        const fetchedApps = await this.fetchAppsFromRegistry(registry);
        this.log.info({ store: this.storeName, registry: registry.name, count: fetchedApps.length }, 'Fetched apps');

        // Process each app
        for (const fetchedApp of fetchedApps) {
          try {
            // Check if app exists and get its version
            const existing = db.prepare(`SELECT id, data FROM ${this.appCacheTable} WHERE id = ? AND registry = ?`)
              .get(fetchedApp.id, registry.id) as { id: string; data: string } | undefined;

            // Download icon (store-specific implementation)
            await this.downloadIcon(fetchedApp.id, registry.id, fetchedApp.data).catch(err => {
              this.log.warn({ store: this.storeName, appId: fetchedApp.id, error: err }, 'Failed to download icon');
            });

            // Transform and cache the app
            const app = this.transformApp(fetchedApp.id, registry.id, fetchedApp.data);

            db.prepare(`
              INSERT OR REPLACE INTO ${this.appCacheTable} (id, registry, data, updated_at)
              VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `).run(fetchedApp.id, registry.id, JSON.stringify(app));

            syncedAppIds.get(registry.id)!.add(fetchedApp.id);

            if (existing) {
              const oldApp = JSON.parse(existing.data) as TApp;
              if (oldApp.version !== fetchedApp.version) {
                updated++;
              }
            } else {
              synced++;
            }
          } catch (err) {
            const msg = `Failed to process ${fetchedApp.id}: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
            this.log.warn({ store: this.storeName, appId: fetchedApp.id, registry: registry.id, error: err }, msg);
          }
        }

        // Update registry last_sync time
        db.prepare(`UPDATE ${this.registriesTable} SET last_sync = CURRENT_TIMESTAMP WHERE id = ?`).run(registry.id);

      } catch (err) {
        const msg = `Failed to sync ${registry.name}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        this.log.error({ store: this.storeName, registry: registry.id, error: err }, msg);
      }
    }

    // Remove apps no longer in synced registries
    for (const registry of registriesToSync) {
      const syncedIds = syncedAppIds.get(registry.id)!;
      const cachedApps = db.prepare(`SELECT id FROM ${this.appCacheTable} WHERE registry = ?`).all(registry.id) as { id: string }[];

      for (const cached of cachedApps) {
        if (!syncedIds.has(cached.id)) {
          db.prepare(`DELETE FROM ${this.appCacheTable} WHERE id = ? AND registry = ?`).run(cached.id, registry.id);
          removed++;
        }
      }
    }

    this.log.info({ store: this.storeName, synced, updated, removed, errors: errors.length }, 'Sync complete');
    return { synced, updated, removed, errors };
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
