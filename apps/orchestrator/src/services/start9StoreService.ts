/**
 * Start9 App Store Service
 *
 * Syncs apps from Start9 registries (official and community) and extracts
 * Docker images from .s9pk packages for deployment.
 */

import { mkdir, writeFile, rm } from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { extract as tarExtract } from 'tar';
import { getDb } from '../db/index.js';
import logger from '../lib/logger.js';
import { config } from '../config.js';

// Default registries (seeded on first run)
const DEFAULT_REGISTRIES = [
  { id: 'official', name: 'Start9 Official', url: 'https://registry.start9.com' },
  { id: 'community', name: 'Start9 Community', url: 'https://community-registry.start9.com' },
  { id: 'bip110', name: 'BIP-110', url: 'https://start9.bip110.dev' },
];

export interface Start9Registry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  appCount?: number;
  lastSync?: string;
  createdAt: string;
}

// Registry API response types
interface RegistryApp {
  categories: string[];
  'dependency-metadata': Record<string, unknown>;
  icon: string; // base64 encoded
  instructions: string;
  license: string;
  manifest: RegistryManifest;
  'published-at': string;
  versions: string[];
}

interface RegistryManifest {
  id: string;
  title: string;
  version: string;
  'git-hash': string;
  'release-notes': string;
  license: string;
  'wrapper-repo': string;
  'upstream-repo': string;
  'support-site': string;
  'marketing-site': string;
  'donation-url'?: string;
  description: {
    short: string;
    long: string;
  };
  assets?: {
    license?: string;
    icon?: string;
    instructions?: string;
  };
  interfaces?: Record<string, {
    name: string;
    description: string;
    'tor-config'?: unknown;
    'lan-config'?: unknown;
    ui?: boolean;
    protocols: string[];
  }>;
  dependencies?: Record<string, unknown>;
}

export interface Start9AppDefinition {
  id: string;
  name: string;
  version: string;
  gitHash: string;
  shortDescription: string;
  longDescription: string;
  releaseNotes?: string;
  license: string;
  wrapperRepo: string;
  upstreamRepo: string;
  supportSite: string;
  marketingSite: string;
  donationUrl?: string;
  icon: string;
  categories: string[];
  interfaces: Array<{
    name: string;
    description: string;
    protocols: string[];
    ui: boolean;
  }>;
  dependencies: string[];
  registry: string; // 'official' or 'community'
  publishedAt: string;
  versions: string[];
}

interface Start9AppCacheRow {
  id: string;
  data: string; // JSON stringified Start9AppDefinition
  registry: string;
  updated_at: string;
}

class Start9StoreService {
  private initialized = false;

  /**
   * Initialize the Start9 store - create tables if needed
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = getDb();

    // Check if table needs migration (old schema or single primary key)
    const tableInfo = db.prepare(`PRAGMA table_info(start9_app_cache)`).all() as { name: string; pk: number }[];
    const hasOldSchema = tableInfo.some(col => col.name === 'manifest');
    // Check if registry is part of primary key (pk > 0)
    const registryCol = tableInfo.find(col => col.name === 'registry');
    const needsMigration = hasOldSchema || (registryCol && registryCol.pk === 0);

    if (needsMigration) {
      // Drop old table and recreate with composite primary key
      logger.info('Migrating Start9 app cache to composite key schema');
      db.exec(`DROP TABLE IF EXISTS start9_app_cache`);
    }

    // Create Start9 app cache table with composite primary key (id + registry)
    db.exec(`
      CREATE TABLE IF NOT EXISTS start9_app_cache (
        id TEXT NOT NULL,
        registry TEXT NOT NULL DEFAULT 'official',
        data TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, registry)
      )
    `);

    // Create Start9 registries table
    db.exec(`
      CREATE TABLE IF NOT EXISTS start9_registries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_sync TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed default registries if none exist
    const registryCount = db.prepare('SELECT COUNT(*) as count FROM start9_registries').get() as { count: number };
    if (registryCount.count === 0) {
      const insertStmt = db.prepare('INSERT INTO start9_registries (id, name, url, enabled) VALUES (?, ?, ?, 1)');
      for (const reg of DEFAULT_REGISTRIES) {
        insertStmt.run(reg.id, reg.name, reg.url);
      }
      logger.info({ count: DEFAULT_REGISTRIES.length }, 'Seeded default Start9 registries');
    }

    // Create Start9 source entry if not exists
    db.prepare(`
      INSERT OR IGNORE INTO app_sources (id, name, type, url)
      VALUES ('start9', 'Start9 Marketplace', 'start9', 'https://registry.start9.com')
    `).run();

    this.initialized = true;
    logger.info('Start9StoreService initialized');
  }

  /**
   * Get all registries
   */
  async getRegistries(): Promise<Start9Registry[]> {
    await this.initialize();
    const db = getDb();

    const rows = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM start9_app_cache WHERE registry = r.id) as app_count
      FROM start9_registries r
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
  async getRegistry(id: string): Promise<Start9Registry | null> {
    await this.initialize();
    const db = getDb();

    const row = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM start9_app_cache WHERE registry = r.id) as app_count
      FROM start9_registries r
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
  async addRegistry(id: string, name: string, url: string): Promise<Start9Registry> {
    await this.initialize();
    const db = getDb();

    // Validate URL format
    try {
      new URL(url);
    } catch {
      throw new Error('Invalid registry URL');
    }

    // Normalize URL (remove trailing slash)
    const normalizedUrl = url.replace(/\/+$/, '');

    // Check for duplicate URL
    const existing = db.prepare('SELECT id FROM start9_registries WHERE url = ?').get(normalizedUrl);
    if (existing) {
      throw new Error('A registry with this URL already exists');
    }

    // Check for duplicate ID
    const existingId = db.prepare('SELECT id FROM start9_registries WHERE id = ?').get(id);
    if (existingId) {
      throw new Error('A registry with this ID already exists');
    }

    db.prepare('INSERT INTO start9_registries (id, name, url, enabled) VALUES (?, ?, ?, 1)')
      .run(id, name, normalizedUrl);

    logger.info({ id, name, url: normalizedUrl }, 'Added Start9 registry');

    return {
      id,
      name,
      url: normalizedUrl,
      enabled: true,
      appCount: 0,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Update a registry
   */
  async updateRegistry(id: string, updates: { name?: string; url?: string; enabled?: boolean }): Promise<Start9Registry | null> {
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
      // Validate and normalize URL
      try {
        new URL(updates.url);
      } catch {
        throw new Error('Invalid registry URL');
      }
      const normalizedUrl = updates.url.replace(/\/+$/, '');

      // Check for duplicate URL (excluding current registry)
      const duplicate = db.prepare('SELECT id FROM start9_registries WHERE url = ? AND id != ?').get(normalizedUrl, id);
      if (duplicate) {
        throw new Error('A registry with this URL already exists');
      }

      fields.push('url = ?');
      values.push(normalizedUrl);
    }

    if (updates.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }

    if (fields.length === 0) {
      return existing;
    }

    values.push(id);
    db.prepare(`UPDATE start9_registries SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    logger.info({ id, updates }, 'Updated Start9 registry');

    return this.getRegistry(id);
  }

  /**
   * Remove a registry and its cached apps
   */
  async removeRegistry(id: string): Promise<boolean> {
    await this.initialize();
    const db = getDb();

    const existing = db.prepare('SELECT id FROM start9_registries WHERE id = ?').get(id);
    if (!existing) return false;

    // Delete cached apps for this registry
    db.prepare('DELETE FROM start9_app_cache WHERE registry = ?').run(id);

    // Delete the registry
    db.prepare('DELETE FROM start9_registries WHERE id = ?').run(id);

    logger.info({ id }, 'Removed Start9 registry');

    return true;
  }

  /**
   * Fetch apps from a Start9 registry by URL
   */
  private async fetchRegistryByUrl(url: string): Promise<RegistryApp[]> {
    const apiUrl = `${url}/package/v0/index`;

    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'OwnPrem/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Registry API error: ${response.status}`);
    }

    return await response.json() as RegistryApp[];
  }

  /**
   * Convert registry app to our format
   */
  private registryAppToDefinition(app: RegistryApp, registryId: string): Start9AppDefinition {
    const manifest = app.manifest;

    // Extract interfaces
    const interfaces: Start9AppDefinition['interfaces'] = [];
    if (manifest.interfaces) {
      for (const [key, iface] of Object.entries(manifest.interfaces)) {
        interfaces.push({
          name: iface.name || key,
          description: iface.description || '',
          protocols: iface.protocols || [],
          ui: iface.ui || false,
        });
      }
    }

    // Extract dependencies
    const dependencies: string[] = [];
    if (manifest.dependencies) {
      dependencies.push(...Object.keys(manifest.dependencies));
    }

    return {
      id: manifest.id,
      name: manifest.title,
      version: manifest.version,
      gitHash: manifest['git-hash'],
      shortDescription: manifest.description?.short || '',
      longDescription: manifest.description?.long || '',
      releaseNotes: manifest['release-notes'],
      license: manifest.license,
      wrapperRepo: manifest['wrapper-repo'] || '',
      upstreamRepo: manifest['upstream-repo'] || '',
      supportSite: manifest['support-site'] || '',
      marketingSite: manifest['marketing-site'] || '',
      donationUrl: manifest['donation-url'],
      icon: `/api/start9/apps/${registryId}/${manifest.id}/icon`,
      categories: app.categories || [],
      interfaces,
      dependencies,
      registry: registryId,
      publishedAt: app['published-at'],
      versions: app.versions || [manifest.version],
    };
  }

  /**
   * Sync apps from Start9 registries
   * @param registryId - Optional: registry ID to sync only one registry
   */
  async syncApps(registryId?: string): Promise<{ synced: number; updated: number; removed: number; errors: string[] }> {
    await this.initialize();

    const db = getDb();
    let synced = 0;
    let updated = 0;
    let removed = 0;
    const errors: string[] = [];
    const syncedAppIds = new Map<string, Set<string>>(); // registry -> Set<appId>

    // Get registries to sync from database
    let registriesToSync: Start9Registry[];
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

    // Sync selected registries
    for (const registry of registriesToSync) {
      syncedAppIds.set(registry.id, new Set());
      try {
        logger.info({ registry: registry.name, url: registry.url }, 'Fetching Start9 registry');
        const apps = await this.fetchRegistryByUrl(registry.url);
        logger.info({ registry: registry.name, count: apps.length }, 'Fetched Start9 apps');

        for (const app of apps) {
          try {
            const appDef = this.registryAppToDefinition(app, registry.id);
            const appId = appDef.id;
            syncedAppIds.get(registry.id)!.add(appId);

            // Check if app already exists in this registry
            const existing = db.prepare('SELECT id, data FROM start9_app_cache WHERE id = ? AND registry = ?')
              .get(appId, registry.id) as { id: string; data: string } | undefined;

            // Store in cache (composite key: id + registry)
            db.prepare(`
              INSERT OR REPLACE INTO start9_app_cache (id, registry, data, updated_at)
              VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `).run(appId, registry.id, JSON.stringify(appDef));

            // Save icon (decode from base64)
            if (app.icon) {
              await this.saveIcon(appId, registry.id, app.icon).catch(err => {
                logger.warn({ appId, error: err }, 'Failed to save Start9 icon');
              });
            }

            if (existing) {
              const oldData = JSON.parse(existing.data) as Start9AppDefinition;
              if (oldData.version !== appDef.version) {
                updated++;
                logger.info({ appId, oldVersion: oldData.version, newVersion: appDef.version }, 'Updated Start9 app');
              }
            } else {
              synced++;
              logger.debug({ appId, registry: registry.id }, 'Added new Start9 app');
            }
          } catch (err) {
            const msg = `Failed to process ${app.manifest?.id || 'unknown'}: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
            logger.warn({ error: err }, msg);
          }
        }

        // Update registry last_sync time
        db.prepare('UPDATE start9_registries SET last_sync = CURRENT_TIMESTAMP WHERE id = ?').run(registry.id);
      } catch (err) {
        const msg = `Failed to sync ${registry.name} registry: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        logger.error({ registry: registry.id, error: err }, msg);
      }
    }

    // Remove apps no longer in the synced registries
    for (const registry of registriesToSync) {
      const syncedIds = syncedAppIds.get(registry.id)!;
      const cachedApps = db.prepare('SELECT id FROM start9_app_cache WHERE registry = ?').all(registry.id) as { id: string }[];

      for (const cached of cachedApps) {
        if (!syncedIds.has(cached.id)) {
          db.prepare('DELETE FROM start9_app_cache WHERE id = ? AND registry = ?').run(cached.id, registry.id);
          removed++;
          logger.info({ appId: cached.id, registry: registry.id }, 'Removed Start9 app');
        }
      }
    }

    // Update last sync time for the source
    db.prepare(`UPDATE app_sources SET last_sync = CURRENT_TIMESTAMP WHERE id = 'start9'`).run();

    logger.info({ synced, updated, removed, errors: errors.length }, 'Start9 app sync complete');
    return { synced, updated, removed, errors };
  }

  /**
   * Save icon from base64 data
   */
  private async saveIcon(appId: string, registryId: string, base64Data: string): Promise<void> {
    const iconsDir = join(config.paths.icons, 'start9', registryId);
    if (!existsSync(iconsDir)) {
      await mkdir(iconsDir, { recursive: true });
    }

    // Decode base64
    const iconBuffer = Buffer.from(base64Data, 'base64');

    // Detect file type from magic bytes
    const isSvg = iconBuffer.toString('utf8', 0, 100).includes('<svg') ||
                  iconBuffer.toString('utf8', 0, 100).includes('<?xml');
    const isPng = iconBuffer[0] === 0x89 && iconBuffer[1] === 0x50 &&
                  iconBuffer[2] === 0x4E && iconBuffer[3] === 0x47;

    const ext = isSvg ? 'svg' : isPng ? 'png' : 'png';
    const iconPath = join(iconsDir, `${appId}.${ext}`);
    await writeFile(iconPath, iconBuffer);
    logger.debug({ appId, registry: registryId, iconPath, format: ext }, 'Saved Start9 icon');
  }

  /**
   * Get all cached Start9 apps
   */
  async getApps(): Promise<Start9AppDefinition[]> {
    await this.initialize();

    const db = getDb();
    const rows = db.prepare('SELECT * FROM start9_app_cache ORDER BY registry, id').all() as Start9AppCacheRow[];

    return rows.map(row => JSON.parse(row.data) as Start9AppDefinition);
  }

  /**
   * Get a single Start9 app by ID
   * If registry is specified, only looks in that registry
   * Otherwise, returns the first match found in order of registry creation
   */
  async getApp(id: string, registryId?: string): Promise<Start9AppDefinition | null> {
    await this.initialize();

    const db = getDb();
    let row: Start9AppCacheRow | undefined;

    if (registryId) {
      row = db.prepare('SELECT * FROM start9_app_cache WHERE id = ? AND registry = ?').get(id, registryId) as Start9AppCacheRow | undefined;
    } else {
      // Get from the first registry that has this app (ordered by registry creation)
      row = db.prepare(`
        SELECT c.* FROM start9_app_cache c
        JOIN start9_registries r ON c.registry = r.id
        WHERE c.id = ?
        ORDER BY r.created_at ASC
        LIMIT 1
      `).get(id) as Start9AppCacheRow | undefined;
    }

    if (!row) return null;
    return JSON.parse(row.data) as Start9AppDefinition;
  }

  /**
   * Get app count
   */
  async getAppCount(): Promise<number> {
    await this.initialize();

    const db = getDb();
    const result = db.prepare('SELECT COUNT(*) as count FROM start9_app_cache').get() as { count: number };
    return result.count;
  }

  /**
   * Check if sync is needed (older than 1 hour)
   */
  async needsSync(): Promise<boolean> {
    await this.initialize();

    const db = getDb();
    const source = db.prepare(`SELECT last_sync FROM app_sources WHERE id = 'start9'`).get() as { last_sync: string | null } | undefined;

    if (!source?.last_sync) return true;

    const lastSync = new Date(source.last_sync);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    return lastSync < oneHourAgo;
  }

  /**
   * Get the s9pk download URL for an app
   */
  async getS9pkUrl(appId: string, registryId?: string): Promise<string | null> {
    const app = await this.getApp(appId, registryId);
    if (!app) return null;

    const registry = await this.getRegistry(app.registry);
    if (!registry) return null;

    // S9pk URL format: {registry}/package/v0/{id}.s9pk
    return `${registry.url}/package/v0/${appId}.s9pk`;
  }

  /**
   * Download and extract s9pk package, returning path to Docker image tar
   */
  async downloadAndExtractS9pk(appId: string): Promise<{ imagePath: string; cleanup: () => Promise<void> }> {
    const s9pkUrl = await this.getS9pkUrl(appId);
    if (!s9pkUrl) {
      throw new Error(`No s9pk URL available for app: ${appId}`);
    }

    const tempDir = join(config.paths.data, 'tmp', `s9pk-${appId}-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    const s9pkPath = join(tempDir, `${appId}.s9pk`);

    try {
      // Download s9pk
      logger.info({ appId, url: s9pkUrl }, 'Downloading s9pk');
      const response = await fetch(s9pkUrl);
      if (!response.ok) {
        throw new Error(`Failed to download s9pk: ${response.status}`);
      }

      // Write to file
      const fileStream = createWriteStream(s9pkPath);
      // @ts-expect-error - Node.js stream compatibility
      await pipeline(response.body, fileStream);

      // Extract s9pk (it's a tar file)
      logger.info({ appId, s9pkPath }, 'Extracting s9pk');
      await tarExtract({
        file: s9pkPath,
        cwd: tempDir,
      });

      // Find the x86_64.tar image
      const imagePath = join(tempDir, 'x86_64.tar');
      if (!existsSync(imagePath)) {
        // Try aarch64 as fallback
        const armPath = join(tempDir, 'aarch64.tar');
        if (existsSync(armPath)) {
          throw new Error('Only ARM64 image available, x86_64 not found');
        }
        throw new Error('No Docker image found in s9pk');
      }

      logger.info({ appId, imagePath }, 'Extracted Docker image from s9pk');

      return {
        imagePath,
        cleanup: async () => {
          try {
            await rm(tempDir, { recursive: true, force: true });
          } catch (err) {
            logger.warn({ tempDir, error: err }, 'Failed to cleanup temp directory');
          }
        },
      };
    } catch (err) {
      // Cleanup on error
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * Load Docker image from s9pk into Docker daemon
   */
  async loadDockerImage(appId: string): Promise<string> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const { imagePath, cleanup } = await this.downloadAndExtractS9pk(appId);

    try {
      // Load image into Docker
      logger.info({ appId, imagePath }, 'Loading Docker image');
      const { stdout } = await execAsync(`docker load < "${imagePath}"`);

      // Parse the image ID/name from output
      // Output format: "Loaded image: start9/electrs:0.10.6"
      const match = stdout.match(/Loaded image:\s*(.+)/);
      const imageId = match ? match[1].trim() : '';

      logger.info({ appId, imageId }, 'Loaded Docker image from s9pk');

      return imageId;
    } finally {
      await cleanup();
    }
  }
}

export const start9StoreService = new Start9StoreService();
