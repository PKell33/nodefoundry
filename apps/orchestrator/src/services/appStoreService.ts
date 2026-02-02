/**
 * Umbrel App Store Service
 *
 * Syncs apps from Umbrel-compatible registries (GitHub-based stores)
 * and parses umbrel-app.yml manifests.
 */

import { parse as parseYaml } from 'yaml';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/index.js';
import { BaseStoreService, type StoreRegistry, type BaseAppDefinition, type DefaultRegistry } from './baseStoreService.js';
import { config } from '../config.js';

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

export interface AppDefinition extends BaseAppDefinition {
  website: string;
  repo: string;
  dependencies: string[];
  gallery: string[];
  composeFile: string;
  manifest: UmbrelAppManifest;
}

// Re-export registry type for backward compatibility
export type UmbrelRegistry = StoreRegistry;

// Internal type for raw app data during sync
interface UmbrelRawData {
  manifest: UmbrelAppManifest;
  composeFile: string;
  galleryBase: string;
}

// Legacy app_cache row format (Umbrel uses different schema)
interface AppCacheRow {
  id: string;
  registry: string;
  category: string;
  manifest: string;
  compose_file: string;
  updated_at: string;
}

class AppStoreService extends BaseStoreService<AppDefinition> {
  protected readonly storeName = 'umbrel';

  protected readonly defaultRegistries: DefaultRegistry[] = [
    {
      id: 'umbrel-official',
      name: 'Umbrel Official',
      url: 'https://github.com/getumbrel/umbrel-apps',
    },
  ];

  // Override table names to use existing tables
  protected override get registriesTable(): string {
    return 'umbrel_registries';
  }

  protected override get appCacheTable(): string {
    return 'app_cache';
  }

  // ==================== Override Initialization ====================

  override async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = getDb();

    // Create registries table (same as base)
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

    // Umbrel uses a different app cache schema with separate manifest and compose_file columns
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.appCacheTable} (
        id TEXT NOT NULL,
        registry TEXT NOT NULL DEFAULT 'umbrel-official',
        category TEXT,
        manifest TEXT NOT NULL,
        compose_file TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, registry)
      )
    `);

    // Ensure registry column exists (migration for old schema)
    const tableInfo = db.prepare(`PRAGMA table_info(${this.appCacheTable})`).all() as { name: string }[];
    const hasRegistry = tableInfo.some(col => col.name === 'registry');
    if (!hasRegistry) {
      db.exec(`ALTER TABLE ${this.appCacheTable} ADD COLUMN registry TEXT DEFAULT 'umbrel-official'`);
    }

    // Seed default registries
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

  // ==================== Store-Specific Implementation ====================

  protected validateRegistryUrl(url: string): void {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.includes('github.com')) {
        throw new Error('URL must be a GitHub repository');
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('GitHub')) throw e;
      throw new Error('Invalid registry URL');
    }
  }

  protected async fetchAppsFromRegistry(registry: StoreRegistry): Promise<Array<{ id: string; version: string; data: unknown }>> {
    const { owner, repo } = this.parseGitHubUrl(registry.url);
    const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents`;
    const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/master`;
    const galleryBase = `https://${owner}.github.io/${repo}`;

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

    const apps: Array<{ id: string; version: string; data: unknown }> = [];
    const batchSize = 20;

    for (let i = 0; i < appDirs.length; i += batchSize) {
      const batch = appDirs.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (appId) => {
          const [manifest, composeFile] = await Promise.all([
            this.fetchManifestFromUrl(`${rawBase}/${appId}/umbrel-app.yml`),
            this.fetchComposeFromUrl(`${rawBase}/${appId}/docker-compose.yml`),
          ]);

          if (manifest && composeFile) {
            return {
              id: appId,
              version: manifest.version,
              data: { manifest, composeFile, galleryBase } as UmbrelRawData,
            };
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

  protected transformApp(appId: string, registryId: string, rawData: unknown): AppDefinition {
    const { manifest, composeFile, galleryBase } = rawData as UmbrelRawData;

    return {
      id: manifest.id || appId,
      name: manifest.name,
      version: manifest.version,
      tagline: manifest.tagline || '',
      description: manifest.description || '',
      category: manifest.category || 'utilities',
      developer: manifest.developer || 'Unknown',
      icon: this.getIconUrl(appId, registryId),
      port: manifest.port || 0,
      registry: registryId,
      website: manifest.website || '',
      repo: manifest.repo || '',
      dependencies: manifest.dependencies || [],
      gallery: (manifest.gallery || []).map(img => `${galleryBase}/${appId}/${img}`),
      composeFile,
      manifest,
    };
  }

  protected async downloadIcon(appId: string, registryId: string, rawData: unknown): Promise<void> {
    const { galleryBase } = rawData as UmbrelRawData;
    const iconUrl = `${galleryBase}/${appId}/icon.svg`;

    const iconsDir = await this.ensureIconDir(registryId);

    const response = await fetch(iconUrl);
    if (!response.ok) return;

    const iconData = await response.arrayBuffer();
    const iconPath = join(iconsDir, `${appId}.svg`);
    await writeFile(iconPath, Buffer.from(iconData));
  }

  // ==================== Override Sync to Use Legacy Schema ====================

  override async syncApps(registryId?: string): Promise<{ synced: number; updated: number; removed: number; errors: string[] }> {
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

        const fetchedApps = await this.fetchAppsFromRegistry(registry);
        this.log.info({ store: this.storeName, registry: registry.name, count: fetchedApps.length }, 'Fetched apps');

        for (const fetchedApp of fetchedApps) {
          try {
            const { manifest, composeFile } = fetchedApp.data as UmbrelRawData;

            const existing = db.prepare(`SELECT id, manifest FROM ${this.appCacheTable} WHERE id = ? AND registry = ?`)
              .get(fetchedApp.id, registry.id) as { id: string; manifest: string } | undefined;

            // Download icon
            await this.downloadIcon(fetchedApp.id, registry.id, fetchedApp.data).catch(err => {
              this.log.warn({ store: this.storeName, appId: fetchedApp.id, error: err }, 'Failed to download icon');
            });

            // Store using Umbrel's legacy schema
            db.prepare(`
              INSERT OR REPLACE INTO ${this.appCacheTable} (id, registry, category, manifest, compose_file, updated_at)
              VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(fetchedApp.id, registry.id, manifest.category, JSON.stringify(manifest), composeFile);

            syncedAppIds.get(registry.id)!.add(fetchedApp.id);

            if (existing) {
              const oldManifest = JSON.parse(existing.manifest) as UmbrelAppManifest;
              if (oldManifest.version !== fetchedApp.version) {
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
          // Check if deployed before removing
          const deployments = db.prepare('SELECT id FROM deployments WHERE app_name = ?').all(cached.id);
          if (deployments.length > 0) {
            this.log.warn({ appId: cached.id }, 'App removed from registry but still deployed - keeping');
          } else {
            db.prepare(`DELETE FROM ${this.appCacheTable} WHERE id = ? AND registry = ?`).run(cached.id, registry.id);
            removed++;
          }
        }
      }
    }

    this.log.info({ store: this.storeName, synced, updated, removed, errors: errors.length }, 'Sync complete');
    return { synced, updated, removed, errors };
  }

  // ==================== Override App Methods for Legacy Schema ====================

  override async getApps(): Promise<AppDefinition[]> {
    await this.initialize();

    const db = getDb();
    const rows = db.prepare(`SELECT * FROM ${this.appCacheTable}`).all() as AppCacheRow[];
    return rows.map(row => this.legacyRowToApp(row));
  }

  override async getApp(id: string, registryId?: string): Promise<AppDefinition | null> {
    await this.initialize();

    const db = getDb();
    let row: AppCacheRow | undefined;

    if (registryId) {
      row = db.prepare(`SELECT * FROM ${this.appCacheTable} WHERE id = ? AND registry = ?`).get(id, registryId) as AppCacheRow | undefined;
    } else {
      row = db.prepare(`SELECT * FROM ${this.appCacheTable} WHERE id = ?`).get(id) as AppCacheRow | undefined;
    }

    if (!row) return null;
    return this.legacyRowToApp(row);
  }

  // ==================== Umbrel-Specific Methods ====================

  /**
   * Get all unique categories with app counts
   */
  async getCategories(): Promise<Array<{ category: string; count: number }>> {
    await this.initialize();

    const db = getDb();
    const rows = db.prepare(`
      SELECT category, COUNT(*) as count
      FROM ${this.appCacheTable}
      GROUP BY category
      ORDER BY count DESC
    `).all() as Array<{ category: string; count: number }>;

    return rows;
  }

  /**
   * Get apps by category
   */
  async getAppsByCategory(category: string): Promise<AppDefinition[]> {
    await this.initialize();

    const db = getDb();
    const rows = db.prepare(`SELECT * FROM ${this.appCacheTable} WHERE category = ?`).all(category) as AppCacheRow[];
    return rows.map(row => this.legacyRowToApp(row));
  }

  // ==================== Private Helpers ====================

  private parseGitHubUrl(url: string): { owner: string; repo: string } {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) {
      throw new Error('Invalid GitHub URL');
    }
    return { owner: parts[0], repo: parts[1] };
  }

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

  private async fetchComposeFromUrl(url: string): Promise<string | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return response.text();
    } catch {
      return null;
    }
  }

  private legacyRowToApp(row: AppCacheRow): AppDefinition {
    const manifest = JSON.parse(row.manifest) as UmbrelAppManifest;
    const registryId = row.registry || 'umbrel-official';

    return {
      id: row.id,
      name: manifest.name,
      version: manifest.version,
      tagline: manifest.tagline || '',
      description: manifest.description || '',
      category: manifest.category || row.category || 'utilities',
      developer: manifest.developer || 'Unknown',
      icon: this.getIconUrl(row.id, registryId),
      port: manifest.port || 0,
      registry: registryId,
      website: manifest.website || '',
      repo: manifest.repo || '',
      dependencies: manifest.dependencies || [],
      gallery: (manifest.gallery || []).map(img => `https://getumbrel.github.io/umbrel-apps/${row.id}/${img}`),
      composeFile: row.compose_file || '',
      manifest,
    };
  }
}

export const appStoreService = new AppStoreService();
