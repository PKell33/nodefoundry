import { parse as parseYaml } from 'yaml';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/index.js';
import logger from '../lib/logger.js';
import { config } from '../config.js';

// Default registries (seeded on first run)
const DEFAULT_REGISTRIES = [
  {
    id: 'umbrel-official',
    name: 'Umbrel Official',
    repoOwner: 'getumbrel',
    repoName: 'umbrel-apps',
    branch: 'master',
  },
];

export interface UmbrelRegistry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  appCount?: number;
  lastSync?: string;
  createdAt: string;
}

export interface UmbrelAppManifest {
  manifestVersion: number;
  id: string;
  category: string;
  name: string;
  version: string;
  tagline: string;
  description: string;
  developer: string;
  website: string;
  dependencies: string[];
  repo: string;
  support: string;
  port: number;
  gallery: string[];
  path: string;
  defaultUsername?: string;
  defaultPassword?: string;
  releaseNotes?: string;
  submitter?: string;
  submission?: string;
}

export interface AppDefinition {
  id: string;
  name: string;
  version: string;
  tagline: string;
  description: string;
  category: string;
  developer: string;
  website: string;
  repo: string;
  port: number;
  dependencies: string[];
  icon: string;
  gallery: string[];
  composeFile: string;
  manifest: UmbrelAppManifest;
  registry?: string;
}

interface AppCacheRow {
  id: string;
  registry: string;
  category: string;
  manifest: string;
  compose_file: string;
  updated_at: string;
}

class AppStoreService {
  private initialized = false;

  /**
   * Initialize the app store - create tables if needed
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = getDb();

    // Create registries table
    db.exec(`
      CREATE TABLE IF NOT EXISTS umbrel_registries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_sync TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Update app_cache to include registry column if not exists
    const tableInfo = db.prepare("PRAGMA table_info(app_cache)").all() as { name: string }[];
    const hasRegistry = tableInfo.some(col => col.name === 'registry');
    if (!hasRegistry) {
      db.exec(`ALTER TABLE app_cache ADD COLUMN registry TEXT DEFAULT 'umbrel-official'`);
    }

    // Seed default registries if none exist
    const registryCount = db.prepare('SELECT COUNT(*) as count FROM umbrel_registries').get() as { count: number };
    if (registryCount.count === 0) {
      const insertStmt = db.prepare('INSERT INTO umbrel_registries (id, name, url, enabled) VALUES (?, ?, ?, 1)');
      for (const reg of DEFAULT_REGISTRIES) {
        const url = `https://github.com/${reg.repoOwner}/${reg.repoName}`;
        insertStmt.run(reg.id, reg.name, url);
      }
      logger.info({ count: DEFAULT_REGISTRIES.length }, 'Seeded default Umbrel registries');
    }

    this.initialized = true;
    logger.info('AppStoreService initialized');
  }

  /**
   * Get all registries
   */
  async getRegistries(): Promise<UmbrelRegistry[]> {
    await this.initialize();
    const db = getDb();

    const rows = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM app_cache WHERE registry = r.id) as app_count
      FROM umbrel_registries r
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
  async getRegistry(id: string): Promise<UmbrelRegistry | null> {
    await this.initialize();
    const db = getDb();

    const row = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM app_cache WHERE registry = r.id) as app_count
      FROM umbrel_registries r
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
  async addRegistry(id: string, name: string, url: string): Promise<UmbrelRegistry> {
    await this.initialize();
    const db = getDb();

    // Validate URL format - must be a GitHub repo URL
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.includes('github.com')) {
        throw new Error('URL must be a GitHub repository');
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('GitHub')) throw e;
      throw new Error('Invalid registry URL');
    }

    // Check for duplicate URL
    const existing = db.prepare('SELECT id FROM umbrel_registries WHERE url = ?').get(url);
    if (existing) {
      throw new Error('A registry with this URL already exists');
    }

    // Check for duplicate ID
    const existingId = db.prepare('SELECT id FROM umbrel_registries WHERE id = ?').get(id);
    if (existingId) {
      throw new Error('A registry with this ID already exists');
    }

    db.prepare('INSERT INTO umbrel_registries (id, name, url, enabled) VALUES (?, ?, ?, 1)')
      .run(id, name, url);

    logger.info({ id, name, url }, 'Added Umbrel registry');

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
  async updateRegistry(id: string, updates: { name?: string; url?: string; enabled?: boolean }): Promise<UmbrelRegistry | null> {
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
        const parsed = new URL(updates.url);
        if (!parsed.hostname.includes('github.com')) {
          throw new Error('URL must be a GitHub repository');
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('GitHub')) throw e;
        throw new Error('Invalid registry URL');
      }

      const duplicate = db.prepare('SELECT id FROM umbrel_registries WHERE url = ? AND id != ?').get(updates.url, id);
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
    db.prepare(`UPDATE umbrel_registries SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    logger.info({ id, updates }, 'Updated Umbrel registry');

    return this.getRegistry(id);
  }

  /**
   * Remove a registry and its cached apps
   */
  async removeRegistry(id: string): Promise<boolean> {
    await this.initialize();
    const db = getDb();

    const existing = db.prepare('SELECT id FROM umbrel_registries WHERE id = ?').get(id);
    if (!existing) return false;

    // Delete cached apps for this registry
    db.prepare('DELETE FROM app_cache WHERE registry = ?').run(id);

    // Delete the registry
    db.prepare('DELETE FROM umbrel_registries WHERE id = ?').run(id);

    logger.info({ id }, 'Removed Umbrel registry');

    return true;
  }

  /**
   * Parse GitHub URL to get owner and repo
   */
  private parseGitHubUrl(url: string): { owner: string; repo: string } {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) {
      throw new Error('Invalid GitHub URL');
    }
    return { owner: parts[0], repo: parts[1] };
  }

  /**
   * Sync apps from a specific registry or all registries
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
    let registriesToSync: UmbrelRegistry[];
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
        const { owner, repo } = this.parseGitHubUrl(registry.url);
        const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents`;
        const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/master`;
        const galleryBase = `https://${owner}.github.io/${repo}`;

        logger.info({ registry: registry.name, url: registry.url }, 'Fetching Umbrel registry');

        // Fetch all apps from this registry
        const allApps = await this.fetchAllAppsFromRegistry(apiBase, rawBase);
        logger.info({ registry: registry.name, total: allApps.length }, 'Fetched app list');

        // Sync each app
        for (const app of allApps) {
          try {
            const existing = db.prepare('SELECT id, manifest FROM app_cache WHERE id = ? AND registry = ?')
              .get(app.id, registry.id) as { id: string; manifest: string } | undefined;

            await this.fetchAndCacheAppFromRegistry(app.id, app.category, registry.id, rawBase, galleryBase);
            syncedAppIds.get(registry.id)!.add(app.id);

            if (existing) {
              const oldManifest = JSON.parse(existing.manifest) as UmbrelAppManifest;
              if (oldManifest.version !== app.version) {
                updated++;
              }
            } else {
              synced++;
            }
          } catch (err) {
            const msg = `Failed to fetch ${app.id}: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
            logger.warn({ appId: app.id, registry: registry.id, error: err }, msg);
          }
        }

        // Update registry last_sync time
        db.prepare('UPDATE umbrel_registries SET last_sync = CURRENT_TIMESTAMP WHERE id = ?').run(registry.id);

      } catch (err) {
        const msg = `Failed to sync ${registry.name}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        logger.error({ registry: registry.id, error: err }, msg);
      }
    }

    // Remove apps no longer in synced registries
    for (const registry of registriesToSync) {
      const syncedIds = syncedAppIds.get(registry.id)!;
      const cachedApps = db.prepare('SELECT id FROM app_cache WHERE registry = ?').all(registry.id) as { id: string }[];

      for (const cached of cachedApps) {
        if (!syncedIds.has(cached.id)) {
          // Check if deployed before removing
          const deployments = db.prepare('SELECT id FROM deployments WHERE app_name = ?').all(cached.id);
          if (deployments.length > 0) {
            logger.warn({ appId: cached.id }, 'App removed but still deployed - keeping');
          } else {
            db.prepare('DELETE FROM app_cache WHERE id = ? AND registry = ?').run(cached.id, registry.id);
            removed++;
          }
        }
      }
    }

    logger.info({ synced, updated, removed, errors: errors.length }, 'Umbrel app sync complete');
    return { synced, updated, removed, errors };
  }

  /**
   * Fetch all apps from a registry
   */
  private async fetchAllAppsFromRegistry(apiBase: string, rawBase: string): Promise<Array<{ id: string; category: string; version: string }>> {
    const response = await fetch(apiBase, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'OwnPrem/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const contents = await response.json() as Array<{ name: string; type: string }>;

    const appDirs = contents
      .filter(item => item.type === 'dir')
      .map(item => item.name)
      .filter(name => !name.startsWith('.') && !name.startsWith('_'));

    const apps: Array<{ id: string; category: string; version: string }> = [];
    const batchSize = 20;

    for (let i = 0; i < appDirs.length; i += batchSize) {
      const batch = appDirs.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (appId) => {
          const manifest = await this.fetchManifestFromUrl(`${rawBase}/${appId}/umbrel-app.yml`);
          if (manifest) {
            return { id: appId, category: manifest.category, version: manifest.version };
          }
          return null;
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          apps.push(result.value);
        }
      }
    }

    return apps;
  }

  /**
   * Fetch and cache a single app from a registry
   */
  private async fetchAndCacheAppFromRegistry(
    appId: string,
    category: string,
    registryId: string,
    rawBase: string,
    galleryBase: string
  ): Promise<void> {
    const [manifest, composeFile] = await Promise.all([
      this.fetchManifestFromUrl(`${rawBase}/${appId}/umbrel-app.yml`),
      this.fetchComposeFromUrl(`${rawBase}/${appId}/docker-compose.yml`),
    ]);

    if (!manifest) {
      throw new Error(`No manifest found for ${appId}`);
    }

    if (!composeFile) {
      throw new Error(`No compose file found for ${appId}`);
    }

    // Download icon
    await this.downloadIconFromUrl(appId, registryId, `${galleryBase}/${appId}/icon.svg`).catch(err => {
      logger.warn({ appId, error: err }, 'Failed to download icon');
    });

    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO app_cache (id, registry, category, manifest, compose_file, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(appId, registryId, category, JSON.stringify(manifest), composeFile);
  }

  /**
   * Download icon from URL
   */
  private async downloadIconFromUrl(appId: string, registryId: string, iconUrl: string): Promise<void> {
    const iconsDir = join(config.paths.icons, 'umbrel', registryId);

    if (!existsSync(iconsDir)) {
      await mkdir(iconsDir, { recursive: true });
    }

    const response = await fetch(iconUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch icon: ${response.status}`);
    }

    const iconData = await response.arrayBuffer();
    const iconPath = join(iconsDir, `${appId}.svg`);
    await writeFile(iconPath, Buffer.from(iconData));
  }

  /**
   * Fetch manifest from URL
   */
  private async fetchManifestFromUrl(url: string): Promise<UmbrelAppManifest | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const yamlContent = await response.text();
      return parseYaml(yamlContent) as UmbrelAppManifest;
    } catch {
      return null;
    }
  }

  /**
   * Fetch compose file from URL
   */
  private async fetchComposeFromUrl(url: string): Promise<string | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return response.text();
    } catch {
      return null;
    }
  }

  /**
   * Get all cached apps
   */
  async getApps(category?: string): Promise<AppDefinition[]> {
    await this.initialize();

    const db = getDb();
    let rows: AppCacheRow[];

    if (category) {
      rows = db.prepare(`SELECT * FROM app_cache WHERE category = ?`).all(category) as AppCacheRow[];
    } else {
      rows = db.prepare(`SELECT * FROM app_cache`).all() as AppCacheRow[];
    }

    return rows.map(row => this.rowToAppDefinition(row));
  }

  /**
   * Get all unique categories with app counts
   */
  async getCategories(): Promise<Array<{ category: string; count: number }>> {
    await this.initialize();

    const db = getDb();
    const rows = db.prepare(`
      SELECT category, COUNT(*) as count
      FROM app_cache
      GROUP BY category
      ORDER BY count DESC
    `).all() as Array<{ category: string; count: number }>;

    return rows;
  }

  /**
   * Get a single app by ID
   */
  async getApp(id: string): Promise<AppDefinition | null> {
    await this.initialize();

    const db = getDb();
    const row = db.prepare(`SELECT * FROM app_cache WHERE id = ?`).get(id) as AppCacheRow | undefined;

    if (!row) {
      return null;
    }

    return this.rowToAppDefinition(row);
  }

  /**
   * Convert database row to AppDefinition
   */
  private rowToAppDefinition(row: AppCacheRow): AppDefinition {
    const manifest = JSON.parse(row.manifest) as UmbrelAppManifest;
    const registryId = row.registry || 'umbrel-official';

    // Try new icon path first, fall back to old path
    const iconPath = `/api/apps/${registryId}/${row.id}/icon`;

    return {
      id: row.id,
      name: manifest.name,
      version: manifest.version,
      tagline: manifest.tagline,
      description: manifest.description,
      category: manifest.category,
      developer: manifest.developer,
      website: manifest.website,
      repo: manifest.repo,
      port: manifest.port,
      dependencies: manifest.dependencies || [],
      icon: iconPath,
      gallery: (manifest.gallery || []).map(img => {
        // Use registry-specific gallery URL
        return `https://getumbrel.github.io/umbrel-apps/${row.id}/${img}`;
      }),
      composeFile: row.compose_file,
      manifest,
      registry: registryId,
    };
  }

  /**
   * Check if apps need to be synced
   */
  async needsSync(): Promise<boolean> {
    await this.initialize();

    const db = getDb();
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
   * Get app count
   */
  async getAppCount(): Promise<number> {
    await this.initialize();

    const db = getDb();
    const result = db.prepare(`SELECT COUNT(*) as count FROM app_cache`).get() as { count: number };
    return result.count;
  }
}

export const appStoreService = new AppStoreService();
