/**
 * CasaOS App Store Service
 *
 * Syncs apps from CasaOS-compatible registries (GitHub-based stores)
 * and parses Docker Compose manifests with x-casaos metadata.
 */

import { mkdir, writeFile, rm, readdir, readFile } from 'fs/promises';
import { createWriteStream, createReadStream, existsSync } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { Extract } from 'unzipper';
import { getDb } from '../db/index.js';
import logger from '../lib/logger.js';
import { config } from '../config.js';
import * as yaml from 'js-yaml';

// Default registries (seeded on first run)
const DEFAULT_REGISTRIES = [
  {
    id: 'casaos-official',
    name: 'CasaOS Official',
    url: 'https://github.com/IceWhaleTech/CasaOS-AppStore/archive/refs/heads/main.zip',
  },
  {
    id: 'bigbear',
    name: 'BigBearCasaOS',
    url: 'https://github.com/bigbeartechworld/big-bear-casaos/archive/refs/heads/master.zip',
  },
  {
    id: 'cool-store',
    name: 'CasaOS Cool Store',
    url: 'https://github.com/cool-store-project/cool-appstore/archive/refs/heads/main.zip',
  },
  {
    id: 'community-apps',
    name: 'CasaOS Community Apps',
    url: 'https://github.com/WisdomSky/CasaOS-LinuxServer-AppStore/archive/refs/heads/main.zip',
  },
];

export interface CasaOSRegistry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  appCount?: number;
  lastSync?: string;
  createdAt: string;
}

export interface CasaOSAppDefinition {
  id: string;
  name: string;
  version: string;
  tagline: string;
  description: string;
  developer: string;
  author: string;
  icon: string;
  screenshot?: string;
  category: string;
  architectures: string[];
  port: number;
  registry: string;
  image: string;
  composeFile: string;
}

interface CasaOSMetadata {
  architectures?: string[];
  main?: string;
  description?: { en_us?: string };
  tagline?: { en_us?: string };
  developer?: string;
  author?: string;
  icon?: string;
  screenshot_link?: string[];
  category?: string;
  port_map?: string;
}

interface CasaOSAppCacheRow {
  id: string;
  data: string;
  registry: string;
  updated_at: string;
}

class CasaOSStoreService {
  private initialized = false;

  /**
   * Initialize the CasaOS store - create tables if needed
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = getDb();

    // Create CasaOS app cache table
    db.exec(`
      CREATE TABLE IF NOT EXISTS casaos_app_cache (
        id TEXT NOT NULL,
        registry TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, registry)
      )
    `);

    // Create CasaOS registries table
    db.exec(`
      CREATE TABLE IF NOT EXISTS casaos_registries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_sync TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed default registries if none exist
    const registryCount = db.prepare('SELECT COUNT(*) as count FROM casaos_registries').get() as { count: number };
    if (registryCount.count === 0) {
      const insertStmt = db.prepare('INSERT INTO casaos_registries (id, name, url, enabled) VALUES (?, ?, ?, 1)');
      for (const reg of DEFAULT_REGISTRIES) {
        insertStmt.run(reg.id, reg.name, reg.url);
      }
      logger.info({ count: DEFAULT_REGISTRIES.length }, 'Seeded default CasaOS registries');
    }

    this.initialized = true;
    logger.info('CasaOSStoreService initialized');
  }

  /**
   * Get all registries
   */
  async getRegistries(): Promise<CasaOSRegistry[]> {
    await this.initialize();
    const db = getDb();

    const rows = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM casaos_app_cache WHERE registry = r.id) as app_count
      FROM casaos_registries r
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
  async getRegistry(id: string): Promise<CasaOSRegistry | null> {
    await this.initialize();
    const db = getDb();

    const row = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM casaos_app_cache WHERE registry = r.id) as app_count
      FROM casaos_registries r
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
  async addRegistry(id: string, name: string, url: string): Promise<CasaOSRegistry> {
    await this.initialize();
    const db = getDb();

    // Validate URL format
    try {
      new URL(url);
    } catch {
      throw new Error('Invalid registry URL');
    }

    // Check for duplicate URL
    const existing = db.prepare('SELECT id FROM casaos_registries WHERE url = ?').get(url);
    if (existing) {
      throw new Error('A registry with this URL already exists');
    }

    // Check for duplicate ID
    const existingId = db.prepare('SELECT id FROM casaos_registries WHERE id = ?').get(id);
    if (existingId) {
      throw new Error('A registry with this ID already exists');
    }

    db.prepare('INSERT INTO casaos_registries (id, name, url, enabled) VALUES (?, ?, ?, 1)')
      .run(id, name, url);

    logger.info({ id, name, url }, 'Added CasaOS registry');

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
  async updateRegistry(id: string, updates: { name?: string; url?: string; enabled?: boolean }): Promise<CasaOSRegistry | null> {
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

      const duplicate = db.prepare('SELECT id FROM casaos_registries WHERE url = ? AND id != ?').get(updates.url, id);
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
    db.prepare(`UPDATE casaos_registries SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    logger.info({ id, updates }, 'Updated CasaOS registry');

    return this.getRegistry(id);
  }

  /**
   * Remove a registry and its cached apps
   */
  async removeRegistry(id: string): Promise<boolean> {
    await this.initialize();
    const db = getDb();

    const existing = db.prepare('SELECT id FROM casaos_registries WHERE id = ?').get(id);
    if (!existing) return false;

    // Delete cached apps for this registry
    db.prepare('DELETE FROM casaos_app_cache WHERE registry = ?').run(id);

    // Delete the registry
    db.prepare('DELETE FROM casaos_registries WHERE id = ?').run(id);

    logger.info({ id }, 'Removed CasaOS registry');

    return true;
  }

  /**
   * Sync apps from a CasaOS registry
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
    let registriesToSync: CasaOSRegistry[];
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
      const tempDir = join(config.paths.data, 'tmp', `casaos-${registry.id}-${Date.now()}`);

      try {
        logger.info({ registry: registry.name, url: registry.url }, 'Fetching CasaOS registry');

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

        // Find the Apps directory (it's inside the extracted folder)
        const extractedDirs = await readdir(tempDir);
        const repoDir = extractedDirs.find(d => d !== 'store.zip' && !d.startsWith('.'));
        if (!repoDir) {
          throw new Error('Could not find extracted repository directory');
        }

        const appsDir = join(tempDir, repoDir, 'Apps');
        if (!existsSync(appsDir)) {
          throw new Error('Apps directory not found in registry');
        }

        // Parse each app
        const appDirs = await readdir(appsDir);
        logger.info({ registry: registry.name, count: appDirs.length }, 'Found CasaOS apps');

        for (const appDir of appDirs) {
          if (appDir.startsWith('.') || appDir.startsWith('_')) continue;

          const composePath = join(appsDir, appDir, 'docker-compose.yml');
          if (!existsSync(composePath)) continue;

          try {
            const composeContent = await readFile(composePath, 'utf-8');
            const compose = yaml.load(composeContent) as Record<string, unknown>;

            const appDef = this.parseComposeToApp(appDir, compose, registry.id, composeContent);
            if (!appDef) continue;

            syncedAppIds.get(registry.id)!.add(appDef.id);

            // Check if app exists
            const existing = db.prepare('SELECT id, data FROM casaos_app_cache WHERE id = ? AND registry = ?')
              .get(appDef.id, registry.id) as { id: string; data: string } | undefined;

            // Store in cache
            db.prepare(`
              INSERT OR REPLACE INTO casaos_app_cache (id, registry, data, updated_at)
              VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `).run(appDef.id, registry.id, JSON.stringify(appDef));

            // Save icon if URL provided
            if (appDef.icon && appDef.icon.startsWith('http')) {
              await this.downloadIcon(appDef.id, registry.id, appDef.icon).catch(err => {
                logger.warn({ appId: appDef.id, error: err }, 'Failed to download CasaOS icon');
              });
            }

            if (existing) {
              const oldData = JSON.parse(existing.data) as CasaOSAppDefinition;
              if (oldData.version !== appDef.version) {
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
        db.prepare('UPDATE casaos_registries SET last_sync = CURRENT_TIMESTAMP WHERE id = ?').run(registry.id);
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
      const cachedApps = db.prepare('SELECT id FROM casaos_app_cache WHERE registry = ?').all(registry.id) as { id: string }[];

      for (const cached of cachedApps) {
        if (!syncedIds.has(cached.id)) {
          db.prepare('DELETE FROM casaos_app_cache WHERE id = ? AND registry = ?').run(cached.id, registry.id);
          removed++;
        }
      }
    }

    logger.info({ synced, updated, removed, errors: errors.length }, 'CasaOS app sync complete');
    return { synced, updated, removed, errors };
  }

  /**
   * Parse Docker Compose file to app definition
   */
  private parseComposeToApp(appDir: string, compose: Record<string, unknown>, registryId: string, composeContent: string): CasaOSAppDefinition | null {
    const casaos = compose['x-casaos'] as CasaOSMetadata | undefined;
    if (!casaos) return null;

    const services = compose['services'] as Record<string, { image?: string; ports?: string[] }> | undefined;
    if (!services) return null;

    const mainService = casaos.main || Object.keys(services)[0];
    const service = services[mainService];
    if (!service) return null;

    // Extract version from image tag
    const image = service.image || '';
    const versionMatch = image.match(/:([^:]+)$/);
    const version = versionMatch ? versionMatch[1] : 'latest';

    // Extract port - handle various Docker Compose port formats
    let port = 0;
    if (service.ports && service.ports.length > 0) {
      const portEntry = service.ports[0];
      if (typeof portEntry === 'string') {
        // Format: "8080:80" or "8080"
        const portMatch = portEntry.match(/(\d+):/);
        if (portMatch) {
          port = parseInt(portMatch[1], 10);
        } else {
          port = parseInt(portEntry, 10) || 0;
        }
      } else if (typeof portEntry === 'number') {
        port = portEntry;
      } else if (typeof portEntry === 'object' && portEntry !== null) {
        // Format: { target: 80, published: 8080 }
        const portObj = portEntry as { published?: number; target?: number };
        port = portObj.published || portObj.target || 0;
      }
    }

    return {
      id: appDir.toLowerCase(),
      name: (compose['name'] as string) || appDir,
      version,
      tagline: casaos.tagline?.en_us || '',
      description: casaos.description?.en_us || '',
      developer: casaos.developer || '',
      author: casaos.author || '',
      icon: casaos.icon || `/api/casaos/apps/${registryId}/${appDir.toLowerCase()}/icon`,
      screenshot: casaos.screenshot_link?.[0],
      category: casaos.category || 'Utilities',
      architectures: casaos.architectures || ['amd64'],
      port,
      registry: registryId,
      image,
      composeFile: composeContent,
    };
  }

  /**
   * Download and save app icon
   */
  private async downloadIcon(appId: string, registryId: string, iconUrl: string): Promise<void> {
    const iconsDir = join(config.paths.icons, 'casaos', registryId);
    if (!existsSync(iconsDir)) {
      await mkdir(iconsDir, { recursive: true });
    }

    const response = await fetch(iconUrl);
    if (!response.ok) return;

    const contentType = response.headers.get('content-type') || '';
    const ext = contentType.includes('svg') ? 'svg' : contentType.includes('png') ? 'png' : 'png';
    const iconPath = join(iconsDir, `${appId}.${ext}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(iconPath, buffer);
  }

  /**
   * Get all cached CasaOS apps
   */
  async getApps(): Promise<CasaOSAppDefinition[]> {
    await this.initialize();

    const db = getDb();
    const rows = db.prepare('SELECT * FROM casaos_app_cache ORDER BY registry, id').all() as CasaOSAppCacheRow[];

    return rows.map(row => JSON.parse(row.data) as CasaOSAppDefinition);
  }

  /**
   * Get a single app by ID
   */
  async getApp(id: string, registryId?: string): Promise<CasaOSAppDefinition | null> {
    await this.initialize();

    const db = getDb();
    let row: CasaOSAppCacheRow | undefined;

    if (registryId) {
      row = db.prepare('SELECT * FROM casaos_app_cache WHERE id = ? AND registry = ?').get(id, registryId) as CasaOSAppCacheRow | undefined;
    } else {
      row = db.prepare(`
        SELECT c.* FROM casaos_app_cache c
        JOIN casaos_registries r ON c.registry = r.id
        WHERE c.id = ?
        ORDER BY r.created_at ASC
        LIMIT 1
      `).get(id) as CasaOSAppCacheRow | undefined;
    }

    if (!row) return null;
    return JSON.parse(row.data) as CasaOSAppDefinition;
  }

  /**
   * Get app count
   */
  async getAppCount(): Promise<number> {
    await this.initialize();

    const db = getDb();
    const result = db.prepare('SELECT COUNT(*) as count FROM casaos_app_cache').get() as { count: number };
    return result.count;
  }
}

export const casaosStoreService = new CasaOSStoreService();
