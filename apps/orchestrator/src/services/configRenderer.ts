import nunjucks from 'nunjucks';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import type { AppManifest, ConfigFile } from '@ownprem/shared';

export class ConfigRenderer {
  private env: nunjucks.Environment;

  constructor() {
    this.env = new nunjucks.Environment(null, {
      autoescape: false,
      throwOnUndefined: true,
    });

    // Add custom filters
    this.env.addFilter('default', (value, defaultValue) => {
      return value !== undefined && value !== null ? value : defaultValue;
    });

    this.env.addFilter('quote', (value) => {
      return `"${String(value).replace(/"/g, '\\"')}"`;
    });

    this.env.addFilter('bool', (value) => {
      return value ? 'true' : 'false';
    });

    this.env.addFilter('json', (value) => {
      return JSON.stringify(value);
    });
  }

  renderTemplate(template: string, context: Record<string, unknown>): string {
    return this.env.renderString(template, context);
  }

  async renderAppConfigs(
    manifest: AppManifest,
    appConfig: Record<string, unknown>,
    secrets: Record<string, unknown>
  ): Promise<ConfigFile[]> {
    const files: ConfigFile[] = [];
    const appDefPath = join(config.paths.appDefinitions, manifest.name);
    const templatesPath = join(appDefPath, 'templates');

    // Merge config and secrets for template context
    const context = {
      ...appConfig,
      ...secrets,
      app: {
        name: manifest.name,
        version: manifest.version,
        displayName: manifest.displayName,
      },
    };

    // Check for templates directory
    if (!existsSync(templatesPath)) {
      return files;
    }

    // Common config file mappings
    const configMappings: Record<string, { template: string; output: string; mode?: string }> = {
      bitcoin: {
        template: 'bitcoin.conf.njk',
        output: '/home/bitcoin/.bitcoin/bitcoin.conf',
        mode: '0640',
      },
      electrs: {
        template: 'electrs.toml.njk',
        output: '/etc/electrs/electrs.toml',
        mode: '0644',
      },
      mempool: {
        template: 'mempool-config.json.njk',
        output: '/opt/ownprem/apps/mempool/backend/mempool-config.json',
        mode: '0644',
      },
      lnd: {
        template: 'lnd.conf.njk',
        output: '/home/lnd/.lnd/lnd.conf',
        mode: '0640',
      },
    };

    const mapping = configMappings[manifest.name];
    if (mapping) {
      const templatePath = join(templatesPath, mapping.template);
      if (existsSync(templatePath)) {
        const template = readFileSync(templatePath, 'utf-8');
        const content = this.renderTemplate(template, context);
        files.push({
          path: mapping.output,
          content,
          mode: mapping.mode,
        });
      }
    }

    // Also check for any .njk files and render them
    // This allows apps to have multiple config files
    const { readdirSync } = await import('fs');
    if (existsSync(templatesPath)) {
      const templateFiles = readdirSync(templatesPath).filter(f => f.endsWith('.njk'));

      for (const templateFile of templateFiles) {
        // Skip if already handled by mapping
        if (mapping && templateFile === mapping.template) {
          continue;
        }

        const templatePath = join(templatesPath, templateFile);
        const template = readFileSync(templatePath, 'utf-8');
        const content = this.renderTemplate(template, context);

        // Determine output path from template name
        const outputName = templateFile.replace('.njk', '');
        const outputPath = `${config.paths.apps}/${manifest.name}/${outputName}`;

        files.push({
          path: outputPath,
          content,
          mode: '0644',
        });
      }
    }

    return files;
  }

  renderInstallScript(manifest: AppManifest, appConfig: Record<string, unknown>): ConfigFile | null {
    const appDefPath = join(config.paths.appDefinitions, manifest.name);
    const scriptPath = join(appDefPath, 'install.sh');

    if (!existsSync(scriptPath)) {
      return null;
    }

    const script = readFileSync(scriptPath, 'utf-8');
    const appDir = `${config.paths.apps}/${manifest.name}`;

    return {
      path: `${appDir}/install.sh`,
      content: script,
      mode: '0755',
    };
  }

  renderConfigureScript(manifest: AppManifest): ConfigFile | null {
    const appDefPath = join(config.paths.appDefinitions, manifest.name);
    const scriptPath = join(appDefPath, 'configure.sh');

    if (!existsSync(scriptPath)) {
      return null;
    }

    const script = readFileSync(scriptPath, 'utf-8');
    const appDir = `${config.paths.apps}/${manifest.name}`;

    return {
      path: `${appDir}/configure.sh`,
      content: script,
      mode: '0755',
    };
  }

  renderUninstallScript(manifest: AppManifest): ConfigFile | null {
    const appDefPath = join(config.paths.appDefinitions, manifest.name);
    const scriptPath = join(appDefPath, 'uninstall.sh');

    if (!existsSync(scriptPath)) {
      return null;
    }

    const script = readFileSync(scriptPath, 'utf-8');
    const appDir = `${config.paths.apps}/${manifest.name}`;

    return {
      path: `${appDir}/uninstall.sh`,
      content: script,
      mode: '0755',
    };
  }

  renderStartScript(manifest: AppManifest): ConfigFile | null {
    const appDefPath = join(config.paths.appDefinitions, manifest.name);
    const scriptPath = join(appDefPath, 'start.sh');

    if (!existsSync(scriptPath)) {
      return null;
    }

    const script = readFileSync(scriptPath, 'utf-8');
    const appDir = `${config.paths.apps}/${manifest.name}`;

    return {
      path: `${appDir}/start.sh`,
      content: script,
      mode: '0755',
    };
  }

  renderStopScript(manifest: AppManifest): ConfigFile | null {
    const appDefPath = join(config.paths.appDefinitions, manifest.name);
    const scriptPath = join(appDefPath, 'stop.sh');

    if (!existsSync(scriptPath)) {
      return null;
    }

    const script = readFileSync(scriptPath, 'utf-8');
    const appDir = `${config.paths.apps}/${manifest.name}`;

    return {
      path: `${appDir}/stop.sh`,
      content: script,
      mode: '0755',
    };
  }
}

export const configRenderer = new ConfigRenderer();
