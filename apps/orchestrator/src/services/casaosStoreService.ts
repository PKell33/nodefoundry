/**
 * CasaOS App Store Service
 *
 * Syncs apps from CasaOS-compatible registries (GitHub-based stores)
 * and parses Docker Compose manifests with x-casaos metadata.
 */

import { writeFile, readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { BaseStoreService, type StoreRegistry, type BaseAppDefinition, type DefaultRegistry } from './baseStoreService.js';
import * as yaml from 'js-yaml';

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

export interface CasaOSAppDefinition extends BaseAppDefinition {
  author: string;
  screenshot?: string;
  architectures: string[];
  image: string;
  composeFile: string;
}

// Re-export registry type for backward compatibility
export type CasaOSRegistry = StoreRegistry;

// Internal type for passing compose data through sync
interface CasaOSRawData {
  appDir: string;
  compose: Record<string, unknown>;
  composeContent: string;
  version: string;
}

class CasaOSStoreService extends BaseStoreService<CasaOSAppDefinition> {
  protected readonly storeName = 'casaos';

  protected readonly defaultRegistries: DefaultRegistry[] = [
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
      id: 'community-apps',
      name: 'CasaOS Community Apps',
      url: 'https://github.com/WisdomSky/CasaOS-LinuxServer-AppStore/archive/refs/heads/main.zip',
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
    const { appsDir, cleanup } = await this.downloadAndExtractZip(registry.url, 'Apps');

    try {
      // Parse each app
      const appDirs = await readdir(appsDir);
      const apps: Array<{ id: string; version: string; data: unknown }> = [];

      for (const appDir of appDirs) {
        if (appDir.startsWith('.') || appDir.startsWith('_')) continue;

        const composePath = join(appsDir, appDir, 'docker-compose.yml');
        if (!existsSync(composePath)) continue;

        try {
          const composeContent = await readFile(composePath, 'utf-8');
          const compose = yaml.load(composeContent) as Record<string, unknown>;

          // Check for x-casaos metadata
          const casaos = compose['x-casaos'] as CasaOSMetadata | undefined;
          if (!casaos) continue;

          // Extract version from main service image
          const services = compose['services'] as Record<string, { image?: string }> | undefined;
          const mainService = casaos.main || (services ? Object.keys(services)[0] : undefined);
          const service = mainService && services ? services[mainService] : undefined;
          const image = service?.image || '';
          const versionMatch = image.match(/:([^:]+)$/);
          const version = versionMatch ? versionMatch[1] : 'latest';

          apps.push({
            id: appDir.toLowerCase(),
            version,
            data: { appDir, compose, composeContent, version } as CasaOSRawData,
          });
        } catch (err) {
          this.log.warn({ appDir, error: err }, 'Failed to parse CasaOS app');
        }
      }

      return apps;
    } finally {
      await cleanup();
    }
  }

  protected transformApp(appId: string, registryId: string, rawData: unknown): CasaOSAppDefinition {
    const { appDir, compose, composeContent, version } = rawData as CasaOSRawData;

    const casaos = compose['x-casaos'] as CasaOSMetadata;
    const services = compose['services'] as Record<string, { image?: string; ports?: unknown[] }>;
    const mainService = casaos.main || Object.keys(services)[0];
    const service = services[mainService];

    // Extract port - handle various Docker Compose port formats
    let port = 0;
    if (service?.ports && service.ports.length > 0) {
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

    const image = service?.image || '';

    return {
      id: appDir.toLowerCase(),
      name: (compose['name'] as string) || appDir,
      version,
      tagline: casaos.tagline?.en_us || '',
      description: casaos.description?.en_us || '',
      category: casaos.category || 'Utilities',
      developer: casaos.developer || casaos.author || 'Unknown',
      icon: this.getIconUrl(appDir.toLowerCase(), registryId),
      port,
      registry: registryId,
      author: casaos.author || '',
      screenshot: casaos.screenshot_link?.[0],
      architectures: casaos.architectures || ['amd64'],
      image,
      composeFile: composeContent,
    };
  }

  protected async downloadIcon(appId: string, registryId: string, rawData: unknown): Promise<boolean> {
    const { compose } = rawData as CasaOSRawData;
    const casaos = compose['x-casaos'] as CasaOSMetadata | undefined;

    const iconUrl = casaos?.icon;
    if (!iconUrl || !iconUrl.startsWith('http')) return false;

    const iconsDir = await this.ensureIconDir(registryId);

    const response = await fetch(iconUrl);
    if (!response.ok) return false;

    const contentType = response.headers.get('content-type') || '';
    const ext = contentType.includes('svg') ? 'svg' : contentType.includes('png') ? 'png' : 'png';
    const iconPath = join(iconsDir, `${appId}.${ext}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(iconPath, buffer);
    return true;
  }
}

export const casaosStoreService = new CasaOSStoreService();
