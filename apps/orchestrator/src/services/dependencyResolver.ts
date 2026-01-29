import { getDb } from '../db/index.js';
import { serviceRegistry } from './serviceRegistry.js';
import { secretsManager } from './secretsManager.js';
import type { AppManifest, ServiceRequirement } from '@ownprem/shared';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ResolvedDependency {
  service: string;
  host: string;
  port: number;
  credentials?: Record<string, string>;
  sameServer: boolean;
}

interface DeploymentRow {
  id: string;
  server_id: string;
  app_name: string;
  config: string;
}

interface AppRegistryRow {
  name: string;
  manifest: string;
}

export class DependencyResolver {
  async validate(manifest: AppManifest, targetServerId: string): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const req of manifest.requires || []) {
      const provider = await serviceRegistry.findService(req.service);

      if (!provider) {
        if (req.optional) {
          warnings.push(`Optional service '${req.service}' not available`);
        } else {
          errors.push(`Required service '${req.service}' not found. Install an app that provides it first.`);
        }
        continue;
      }

      const sameServer = provider.serverId === targetServerId;

      if (req.locality === 'same-server' && !sameServer) {
        errors.push(`Service '${req.service}' must be on the same server (currently on ${provider.serverId})`);
      }

      if (req.locality === 'prefer-same-server' && !sameServer) {
        warnings.push(`Service '${req.service}' is on a different server (${provider.serverId}) - may have higher latency`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  async resolve(
    manifest: AppManifest,
    targetServerId: string,
    userConfig: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const config: Record<string, unknown> = { ...userConfig };

    // Resolve service dependencies
    for (const req of manifest.requires || []) {
      const resolved = await this.resolveService(req, targetServerId);

      if (resolved) {
        // Inject host
        if (req.injectAs.host) {
          config[req.injectAs.host] = resolved.host;
        }

        // Inject port
        if (req.injectAs.port) {
          config[req.injectAs.port] = resolved.port;
        }

        // Inject credentials
        if (req.injectAs.credentials && resolved.credentials) {
          for (const [sourceField, targetField] of Object.entries(req.injectAs.credentials)) {
            if (resolved.credentials[sourceField]) {
              config[targetField] = resolved.credentials[sourceField];
            }
          }
        }
      }
    }

    // Handle inheritFrom fields
    for (const field of manifest.configSchema) {
      if (field.inheritFrom && config[field.name] === undefined) {
        const inheritedValue = await this.getInheritedValue(field.inheritFrom);
        if (inheritedValue !== undefined) {
          config[field.name] = inheritedValue;
        }
      }
    }

    // Apply defaults for missing fields
    for (const field of manifest.configSchema) {
      if (config[field.name] === undefined && field.default !== undefined) {
        config[field.name] = field.default;
      }
    }

    return config;
  }

  private async resolveService(
    req: ServiceRequirement,
    consumerServerId: string
  ): Promise<ResolvedDependency | null> {
    const db = getDb();

    // Find the service with locality preference
    const preferSameServer = req.locality === 'same-server' || req.locality === 'prefer-same-server';
    const connection = await serviceRegistry.getConnection(req.service, consumerServerId, preferSameServer);

    if (!connection) {
      if (req.optional) {
        return null;
      }
      throw new Error(`Required service '${req.service}' not found`);
    }

    // Get the service to find its deployment
    const service = await serviceRegistry.findService(req.service);
    if (!service) {
      return null;
    }

    // Get credentials if needed
    let credentials: Record<string, string> | undefined;
    if (req.injectAs.credentials) {
      const fields = Object.keys(req.injectAs.credentials);
      const creds = await secretsManager.getServiceCredentials(service.deploymentId, fields);
      if (creds) {
        credentials = creds;
      }
    }

    return {
      service: req.service,
      host: connection.host,
      port: connection.port,
      credentials,
      sameServer: service.serverId === consumerServerId,
    };
  }

  private async getInheritedValue(inheritFrom: string): Promise<unknown> {
    const [appName, fieldName] = inheritFrom.split('.');
    if (!appName || !fieldName) {
      return undefined;
    }

    const db = getDb();

    // Find a deployment of the specified app
    const deployment = db.prepare(`
      SELECT config FROM deployments WHERE app_name = ? AND status IN ('running', 'stopped', 'configuring')
      LIMIT 1
    `).get(appName) as { config: string } | undefined;

    if (!deployment) {
      return undefined;
    }

    const config = JSON.parse(deployment.config);
    return config[fieldName];
  }

  async getServiceProviders(serviceName: string): Promise<Array<{ serverId: string; host: string; port: number }>> {
    const services = await serviceRegistry.findAllServices(serviceName);
    return services.map(s => ({
      serverId: s.serverId,
      host: s.host,
      port: s.port,
    }));
  }

  async getDependencyTree(appName: string): Promise<Array<{ app: string; requires: string[] }>> {
    const db = getDb();
    const tree: Array<{ app: string; requires: string[] }> = [];
    const visited = new Set<string>();

    const buildTree = async (name: string) => {
      if (visited.has(name)) {
        return;
      }
      visited.add(name);

      const row = db.prepare('SELECT manifest FROM app_registry WHERE name = ?').get(name) as AppRegistryRow | undefined;
      if (!row) {
        return;
      }

      const manifest = JSON.parse(row.manifest) as AppManifest;
      const requires = (manifest.requires || []).map(r => r.service);
      tree.push({ app: name, requires });

      // Recursively find apps that provide required services
      for (const req of manifest.requires || []) {
        const service = await serviceRegistry.findService(req.service);
        if (service) {
          const deployment = db.prepare('SELECT app_name FROM deployments WHERE id = ?').get(service.deploymentId) as { app_name: string } | undefined;
          if (deployment) {
            await buildTree(deployment.app_name);
          }
        }
      }
    };

    await buildTree(appName);
    return tree;
  }
}

export const dependencyResolver = new DependencyResolver();
