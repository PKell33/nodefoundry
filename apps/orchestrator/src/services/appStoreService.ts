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

class AppStoreService extends BaseStoreService<AppDefinition> {
  protected readonly storeName = 'umbrel';

  protected readonly defaultRegistries: DefaultRegistry[] = [
    {
      id: 'umbrel-official',
      name: 'Umbrel Official',
      url: 'https://github.com/getumbrel/umbrel-apps',
    },
  ];

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
    // Gallery images are hosted in a separate repo with '-gallery' suffix
    const galleryBase = `https://${owner}.github.io/${repo}-gallery`;

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

  // ==================== Umbrel-Specific Overrides ====================

  /**
   * Override icon URL to use legacy /api/apps path (not /api/umbrel/apps)
   */
  protected override getIconUrl(appId: string, registryId: string): string {
    return `/api/apps/${registryId}/${appId}/icon`;
  }

  // ==================== Umbrel-Specific Methods ====================

  /**
   * Get all unique categories with app counts
   */
  async getCategories(): Promise<Array<{ category: string; count: number }>> {
    await this.initialize();

    const apps = await this.getApps();
    const categoryMap = new Map<string, number>();

    for (const app of apps) {
      const category = app.category || 'utilities';
      categoryMap.set(category, (categoryMap.get(category) || 0) + 1);
    }

    return Array.from(categoryMap.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Get apps by category
   */
  async getAppsByCategory(category: string): Promise<AppDefinition[]> {
    await this.initialize();

    const apps = await this.getApps();
    return apps.filter(app => app.category === category);
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
}

export const appStoreService = new AppStoreService();
