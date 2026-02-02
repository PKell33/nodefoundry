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
import { BaseStoreService, type StoreRegistry, type BaseAppDefinition, type DefaultRegistry } from './baseStoreService.js';
import { config } from '../config.js';

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

export interface Start9AppDefinition extends BaseAppDefinition {
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
  interfaces: Array<{
    name: string;
    description: string;
    protocols: string[];
    ui: boolean;
  }>;
  dependencies: string[];
  publishedAt: string;
  versions: string[];
}

// Re-export registry type for backward compatibility
export type Start9Registry = StoreRegistry;

class Start9StoreService extends BaseStoreService<Start9AppDefinition> {
  protected readonly storeName = 'start9';

  protected readonly defaultRegistries: DefaultRegistry[] = [
    { id: 'official', name: 'Start9 Official', url: 'https://registry.start9.com' },
    { id: 'community', name: 'Start9 Community', url: 'https://community-registry.start9.com' },
    { id: 'bip110', name: 'BIP-110', url: 'https://start9.bip110.dev' },
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
    const apiUrl = `${registry.url}/package/v0/index`;

    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'OwnPrem/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Registry API error: ${response.status}`);
    }

    const apps = await response.json() as RegistryApp[];

    return apps.map(app => ({
      id: app.manifest.id,
      version: app.manifest.version,
      data: app,
    }));
  }

  protected transformApp(appId: string, registryId: string, rawData: unknown): Start9AppDefinition {
    const app = rawData as RegistryApp;
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
      tagline: manifest.description?.short || '',
      description: manifest.description?.long || '',
      category: app.categories?.[0] || 'utilities',
      categories: app.categories || [],
      developer: manifest['wrapper-repo']?.split('/')[3] || 'Unknown',
      icon: this.getIconUrl(manifest.id, registryId),
      port: 0,
      registry: registryId,
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
      interfaces,
      dependencies,
      publishedAt: app['published-at'],
      versions: app.versions || [manifest.version],
    };
  }

  protected async downloadIcon(appId: string, registryId: string, rawData: unknown): Promise<void> {
    const app = rawData as RegistryApp;
    if (!app.icon) return;

    const iconsDir = await this.ensureIconDir(registryId);

    // Decode base64
    const iconBuffer = Buffer.from(app.icon, 'base64');

    // Detect file type from magic bytes
    const isSvg = iconBuffer.toString('utf8', 0, 100).includes('<svg') ||
                  iconBuffer.toString('utf8', 0, 100).includes('<?xml');
    const isPng = iconBuffer[0] === 0x89 && iconBuffer[1] === 0x50 &&
                  iconBuffer[2] === 0x4E && iconBuffer[3] === 0x47;

    const ext = isSvg ? 'svg' : isPng ? 'png' : 'png';
    const iconPath = join(iconsDir, `${appId}.${ext}`);
    await writeFile(iconPath, iconBuffer);
    this.log.debug({ appId, registry: registryId, iconPath, format: ext }, 'Saved icon');
  }

  // ==================== Start9-Specific Methods ====================

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
      this.log.info({ appId, url: s9pkUrl }, 'Downloading s9pk');
      const response = await fetch(s9pkUrl);
      if (!response.ok) {
        throw new Error(`Failed to download s9pk: ${response.status}`);
      }

      // Write to file
      const fileStream = createWriteStream(s9pkPath);
      // @ts-expect-error - Node.js stream compatibility
      await pipeline(response.body, fileStream);

      // Extract s9pk (it's a tar file)
      this.log.info({ appId, s9pkPath }, 'Extracting s9pk');
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

      this.log.info({ appId, imagePath }, 'Extracted Docker image from s9pk');

      return {
        imagePath,
        cleanup: async () => {
          try {
            await rm(tempDir, { recursive: true, force: true });
          } catch (err) {
            this.log.warn({ tempDir, error: err }, 'Failed to cleanup temp directory');
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
      this.log.info({ appId, imagePath }, 'Loading Docker image');
      const { stdout } = await execAsync(`docker load < "${imagePath}"`);

      // Parse the image ID/name from output
      // Output format: "Loaded image: start9/electrs:0.10.6"
      const match = stdout.match(/Loaded image:\s*(.+)/);
      const imageId = match ? match[1].trim() : '';

      this.log.info({ appId, imageId }, 'Loaded Docker image from s9pk');

      return imageId;
    } finally {
      await cleanup();
    }
  }
}

export const start9StoreService = new Start9StoreService();
