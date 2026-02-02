/**
 * Runtipi App Store Service
 *
 * Syncs apps from Runtipi-compatible registries (GitHub-based stores)
 * and parses config.json metadata files.
 */

import { mkdir, writeFile, rm, readdir, readFile } from 'fs/promises';
import { createWriteStream, createReadStream, existsSync } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { Extract } from 'unzipper';
import { getDb } from '../db/index.js';
import logger from '../lib/logger.js';
import { config } from '../config.js';

// Default registries (seeded on first run)
const DEFAULT_REGISTRIES = [
  {
    id: 'runtipi-official',
    name: 'Runtipi Official',
    url: 'https://github.com/runtipi/runtipi-appstore/archive/refs/heads/master.zip',
  },
];

export interface RuntipiRegistry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  appCount?: number;
  lastSync?: string;
  createdAt: string;
}

export interface RuntipiAppDefinition {
  id: string;
  name: string;
  version: string;
  tipiVersion: number;
  shortDesc: string;
  description: string;
  author: string;
  source: string;
  icon: string;
  categories: string[];
  architectures: string[];
  port: number;
  registry: string;
  exposable: boolean;
  available: boolean;
  composeFile: string;
}

interface RuntipiConfigJson {
  id: string;
  name: string;
  version: string;
  tipi_version?: number;
  short_desc?: string;
  description?: string;
  author?: string;
  source?: string;
  categories?: string[];
  supported_architectures?: string[];
  port?: number;
  exposable?: boolean;
  available?: boolean;
}

interface RuntipiAppCacheRow {
  id: string;
  data: string;
  registry: string;
  updated_at: string;
}

class RuntipiStoreService {
  private initialized = false;

  /**
   * Initialize the Runtipi store - create tables if needed
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = getDb();

    // Create Runtipi app cache table
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtipi_app_cache (
        id TEXT NOT NULL,
        registry TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, registry)
      )
    `);

    // Create Runtipi registries table
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtipi_registries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_sync TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed default registries if none exist
    const registryCount = db.prepare('SELECT COUNT(*) as count FROM runtipi_registries').get() as { count: number };
    if (registryCount.count === 0) {
      const insertStmt = db.prepare('INSERT INTO runtipi_registries (id, name, url, enabled) VALUES (?, ?, ?, 1)');
      for (const reg of DEFAULT_REGISTRIES) {
        insertStmt.run(reg.id, reg.name, reg.url);
      }
      logger.info({ count: DEFAULT_REGISTRIES.length }, 'Seeded default Runtipi registries');
    }

    this.initialized = true;
    logger.info('RuntipiStoreService initialized');
  }

  /**
   * Get all registries
   */
  async getRegistries(): Promise<RuntipiRegistry[]> {
    await this.initialize();
    const db = getDb();

    const rows = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM runtipi_app_cache WHERE registry = r.id) as app_count
      FROM runtipi_registries r
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
  async getRegistry(id: string): Promise<RuntipiRegistry | null> {
    await this.initialize();
    const db = getDb();

    const row = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM runtipi_app_cache WHERE registry = r.id) as app_count
      FROM runtipi_registries r
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
  async addRegistry(id: string, name: string, url: string): Promise<RuntipiRegistry> {
    await this.initialize();
    const db = getDb();

    // Validate URL format
    try {
      new URL(url);
    } catch {
      throw new Error('Invalid registry URL');
    }

    // Check for duplicate URL
    const existing = db.prepare('SELECT id FROM runtipi_registries WHERE url = ?').get(url);
    if (existing) {
      throw new Error('A registry with this URL already exists');
    }

    // Check for duplicate ID
    const existingId = db.prepare('SELECT id FROM runtipi_registries WHERE id = ?').get(id);
    if (existingId) {
      throw new Error('A registry with this ID already exists');
    }

    db.prepare('INSERT INTO runtipi_registries (id, name, url, enabled) VALUES (?, ?, ?, 1)')
      .run(id, name, url);

    logger.info({ id, name, url }, 'Added Runtipi registry');

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
  async updateRegistry(id: string, updates: { name?: string; url?: string; enabled?: boolean }): Promise<RuntipiRegistry | null> {
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
      try {
        new URL(updates.url);
      } catch {
        throw new Error('Invalid registry URL');
      }

      const duplicate = db.prepare('SELECT id FROM runtipi_registries WHERE url = ? AND id != ?').get(updates.url, id);
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
    db.prepare(`UPDATE runtipi_registries SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    logger.info({ id, updates }, 'Updated Runtipi registry');

    return this.getRegistry(id);
  }

  /**
   * Remove a registry and its cached apps
   */
  async removeRegistry(id: string): Promise<boolean> {
    await this.initialize();
    const db = getDb();

    const existing = db.prepare('SELECT id FROM runtipi_registries WHERE id = ?').get(id);
    if (!existing) return false;

    // Delete cached apps for this registry
    db.prepare('DELETE FROM runtipi_app_cache WHERE registry = ?').run(id);

    // Delete the registry
    db.prepare('DELETE FROM runtipi_registries WHERE id = ?').run(id);

    logger.info({ id }, 'Removed Runtipi registry');

    return true;
  }

  /**
   * Sync apps from a Runtipi registry
   */
  async syncApps(registryId?: string): Promise<{ synced: number; updated: number; removed: number; errors: string[] }> {
    await this.initialize();

    const db = getDb();
    let synced = 0;
    let updated = 0;
    let removed = 0;
    const errors: string[] = [];
    const syncedAppIds = new Map<string, Set<string>>();

    // Get registries to sync
    let registriesToSync: RuntipiRegistry[];
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
      const tempDir = join(config.paths.data, 'tmp', `runtipi-${registry.id}-${Date.now()}`);

      try {
        logger.info({ registry: registry.name, url: registry.url }, 'Fetching Runtipi registry');

        // Download and extract the zip file
        await mkdir(tempDir, { recursive: true });
        const zipPath = join(tempDir, 'store.zip');

        const response = await fetch(registry.url);
        if (!response.ok) {
          throw new Error(`Failed to download registry: ${response.status}`);
        }

        const fileStream = createWriteStream(zipPath);
        // @ts-expect-error - Node.js stream compatibility
        await pipeline(response.body, fileStream);

        // Extract zip
        await new Promise<void>((resolve, reject) => {
          createReadStream(zipPath)
            .pipe(Extract({ path: tempDir }))
            .on('close', resolve)
            .on('error', reject);
        });

        // Find the apps directory (it's inside the extracted folder)
        const extractedDirs = await readdir(tempDir);
        const repoDir = extractedDirs.find(d => d !== 'store.zip' && !d.startsWith('.'));
        if (!repoDir) {
          throw new Error('Could not find extracted repository directory');
        }

        const appsDir = join(tempDir, repoDir, 'apps');
        if (!existsSync(appsDir)) {
          throw new Error('Apps directory not found in registry');
        }

        // Parse each app
        const appDirs = await readdir(appsDir);
        logger.info({ registry: registry.name, count: appDirs.length }, 'Found Runtipi apps');

        for (const appDir of appDirs) {
          if (appDir.startsWith('.') || appDir.startsWith('_') || appDir === '__tests__') continue;

          const configPath = join(appsDir, appDir, 'config.json');
          if (!existsSync(configPath)) continue;

          try {
            const configContent = await readFile(configPath, 'utf-8');
            const configJson = JSON.parse(configContent) as RuntipiConfigJson;

            // Skip unavailable apps
            if (configJson.available === false) continue;

            // Read docker-compose if exists
            let composeContent = '';
            const composePath = join(appsDir, appDir, 'docker-compose.yml');
            if (existsSync(composePath)) {
              composeContent = await readFile(composePath, 'utf-8');
            }

            const appDef = this.parseConfigToApp(appDir, configJson, registry.id, composeContent);
            if (!appDef) continue;

            syncedAppIds.get(registry.id)!.add(appDef.id);

            // Check if app exists
            const existing = db.prepare('SELECT id, data FROM runtipi_app_cache WHERE id = ? AND registry = ?')
              .get(appDef.id, registry.id) as { id: string; data: string } | undefined;

            // Store in cache
            db.prepare(`
              INSERT OR REPLACE INTO runtipi_app_cache (id, registry, data, updated_at)
              VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `).run(appDef.id, registry.id, JSON.stringify(appDef));

            // Save icon if exists
            const iconPath = join(appsDir, appDir, 'metadata', 'logo.jpg');
            if (existsSync(iconPath)) {
              await this.saveIcon(appDef.id, registry.id, iconPath).catch(err => {
                logger.warn({ appId: appDef.id, error: err }, 'Failed to save Runtipi icon');
              });
            }

            if (existing) {
              const oldData = JSON.parse(existing.data) as RuntipiAppDefinition;
              if (oldData.version !== appDef.version || oldData.tipiVersion !== appDef.tipiVersion) {
                updated++;
              }
            } else {
              synced++;
            }
          } catch (err) {
            const msg = `Failed to process ${appDir}: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
            logger.warn({ error: err, appDir }, msg);
          }
        }

        // Update registry last_sync time
        db.prepare('UPDATE runtipi_registries SET last_sync = CURRENT_TIMESTAMP WHERE id = ?').run(registry.id);
      } catch (err) {
        const msg = `Failed to sync ${registry.name}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        logger.error({ registry: registry.id, error: err }, msg);
      } finally {
        // Cleanup temp directory
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    // Remove apps no longer in synced registries
    for (const registry of registriesToSync) {
      const syncedIds = syncedAppIds.get(registry.id)!;
      const cachedApps = db.prepare('SELECT id FROM runtipi_app_cache WHERE registry = ?').all(registry.id) as { id: string }[];

      for (const cached of cachedApps) {
        if (!syncedIds.has(cached.id)) {
          db.prepare('DELETE FROM runtipi_app_cache WHERE id = ? AND registry = ?').run(cached.id, registry.id);
          removed++;
        }
      }
    }

    logger.info({ synced, updated, removed, errors: errors.length }, 'Runtipi app sync complete');
    return { synced, updated, removed, errors };
  }

  /**
   * Parse config.json to app definition
   */
  private parseConfigToApp(appDir: string, config: RuntipiConfigJson, registryId: string, composeContent: string): RuntipiAppDefinition | null {
    return {
      id: config.id || appDir.toLowerCase(),
      name: config.name || appDir,
      version: config.version || 'latest',
      tipiVersion: config.tipi_version || 1,
      shortDesc: config.short_desc || '',
      description: config.description || '',
      author: config.author || '',
      source: config.source || '',
      icon: `/api/runtipi/apps/${registryId}/${config.id || appDir.toLowerCase()}/icon`,
      categories: config.categories || ['Uncategorized'],
      architectures: config.supported_architectures || ['amd64'],
      port: config.port || 0,
      registry: registryId,
      exposable: config.exposable ?? true,
      available: config.available ?? true,
      composeFile: composeContent,
    };
  }

  /**
   * Save app icon from extracted files
   */
  private async saveIcon(appId: string, registryId: string, sourcePath: string): Promise<void> {
    const iconsDir = join(config.paths.icons, 'runtipi', registryId);
    if (!existsSync(iconsDir)) {
      await mkdir(iconsDir, { recursive: true });
    }

    const iconContent = await readFile(sourcePath);
    const iconPath = join(iconsDir, `${appId}.jpg`);
    await writeFile(iconPath, iconContent);
  }

  /**
   * Get all cached Runtipi apps
   */
  async getApps(): Promise<RuntipiAppDefinition[]> {
    await this.initialize();

    const db = getDb();
    const rows = db.prepare('SELECT * FROM runtipi_app_cache ORDER BY registry, id').all() as RuntipiAppCacheRow[];

    return rows.map(row => JSON.parse(row.data) as RuntipiAppDefinition);
  }

  /**
   * Get a single app by ID
   */
  async getApp(id: string, registryId?: string): Promise<RuntipiAppDefinition | null> {
    await this.initialize();

    const db = getDb();
    let row: RuntipiAppCacheRow | undefined;

    if (registryId) {
      row = db.prepare('SELECT * FROM runtipi_app_cache WHERE id = ? AND registry = ?').get(id, registryId) as RuntipiAppCacheRow | undefined;
    } else {
      row = db.prepare(`
        SELECT c.* FROM runtipi_app_cache c
        JOIN runtipi_registries r ON c.registry = r.id
        WHERE c.id = ?
        ORDER BY r.created_at ASC
        LIMIT 1
      `).get(id) as RuntipiAppCacheRow | undefined;
    }

    if (!row) return null;
    return JSON.parse(row.data) as RuntipiAppDefinition;
  }

  /**
   * Get app count
   */
  async getAppCount(): Promise<number> {
    await this.initialize();

    const db = getDb();
    const result = db.prepare('SELECT COUNT(*) as count FROM runtipi_app_cache').get() as { count: number };
    return result.count;
  }
}

export const runtipiStoreService = new RuntipiStoreService();
