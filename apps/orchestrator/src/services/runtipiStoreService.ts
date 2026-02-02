/**
 * Runtipi App Store Service
 *
 * Syncs apps from Runtipi-compatible registries (GitHub-based stores)
 * and parses config.json metadata files.
 */

import { writeFile, readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { BaseStoreService, type StoreRegistry, type BaseAppDefinition, type DefaultRegistry } from './baseStoreService.js';

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

export interface RuntipiAppDefinition extends BaseAppDefinition {
  tipiVersion: number;
  shortDesc: string;
  author: string;
  source: string;
  architectures: string[];
  exposable: boolean;
  available: boolean;
  composeFile: string;
}

// Re-export registry type for backward compatibility
export type RuntipiRegistry = StoreRegistry;

// Internal type for passing config data through sync
interface RuntipiRawData {
  appDir: string;
  configJson: RuntipiConfigJson;
  composeContent: string;
  iconPath?: string;
}

class RuntipiStoreService extends BaseStoreService<RuntipiAppDefinition> {
  protected readonly storeName = 'runtipi';

  protected readonly defaultRegistries: DefaultRegistry[] = [
    {
      id: 'runtipi-official',
      name: 'Runtipi Official',
      url: 'https://github.com/runtipi/runtipi-appstore/archive/refs/heads/master.zip',
    },
  ];

  // ==================== Store-Specific Implementation ====================

  protected validateRegistryUrl(url: string): void {
    try {
      new URL(url);
    } catch {
      throw new Error('Invalid registry URL');
    }
  }

  protected async fetchAppsFromRegistry(registry: StoreRegistry): Promise<Array<{ id: string; version: string; data: unknown }>> {
    // Use base class helper to download and extract ZIP
    const { appsDir, cleanup } = await this.downloadAndExtractZip(registry.url, 'apps');

    try {
      // Parse each app
      const appDirs = await readdir(appsDir);
      const apps: Array<{ id: string; version: string; data: unknown }> = [];

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

          // Check for icon
          const iconPath = join(appsDir, appDir, 'metadata', 'logo.jpg');
          const hasIcon = existsSync(iconPath);

          apps.push({
            id: configJson.id || appDir.toLowerCase(),
            version: configJson.version || 'latest',
            data: {
              appDir,
              configJson,
              composeContent,
              iconPath: hasIcon ? iconPath : undefined,
            } as RuntipiRawData,
          });
        } catch (err) {
          this.log.warn({ appDir, error: err }, 'Failed to parse Runtipi app');
        }
      }

      return apps;
    } finally {
      await cleanup();
    }
  }

  protected transformApp(appId: string, registryId: string, rawData: unknown): RuntipiAppDefinition {
    const { appDir, configJson, composeContent } = rawData as RuntipiRawData;

    return {
      id: configJson.id || appDir.toLowerCase(),
      name: configJson.name || appDir,
      version: configJson.version || 'latest',
      tagline: configJson.short_desc || '',
      description: configJson.description || '',
      category: configJson.categories?.[0] || 'Uncategorized',
      categories: configJson.categories || ['Uncategorized'],
      developer: configJson.author || 'Unknown',
      icon: this.getIconUrl(configJson.id || appDir.toLowerCase(), registryId),
      port: configJson.port || 0,
      registry: registryId,
      tipiVersion: configJson.tipi_version || 1,
      shortDesc: configJson.short_desc || '',
      author: configJson.author || '',
      source: configJson.source || '',
      architectures: configJson.supported_architectures || ['amd64'],
      exposable: configJson.exposable ?? true,
      available: configJson.available ?? true,
      composeFile: composeContent,
    };
  }

  protected async downloadIcon(appId: string, registryId: string, rawData: unknown): Promise<boolean> {
    const { iconPath } = rawData as RuntipiRawData;
    if (!iconPath || !existsSync(iconPath)) return false;

    const iconsDir = await this.ensureIconDir(registryId);
    const iconContent = await readFile(iconPath);
    const destPath = join(iconsDir, `${appId}.jpg`);
    await writeFile(destPath, iconContent);
    return true;
  }
}

export const runtipiStoreService = new RuntipiStoreService();
