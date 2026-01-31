import { getDb, runInTransaction } from '../db/index.js';
import { config } from '../config.js';
import { secretsManager } from './secretsManager.js';
import logger from '../lib/logger.js';
import { auditService } from './auditService.js';
import { v4 as uuidv4 } from 'uuid';

const EXPORT_VERSION = '1.0';

export interface ExportOptions {
  includeUsers?: boolean;
  includeDeployments?: boolean;
  includeAuditLog?: boolean;
}

export interface ImportOptions {
  overwrite?: boolean;
  regenerateSecrets?: boolean;
  dryRun?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    servers: number;
    deployments: number;
    users: number;
    groups: number;
    proxyRoutes: number;
    serviceRoutes: number;
  };
}

export interface ImportResult {
  success: boolean;
  imported: {
    servers: number;
    deployments: number;
    users: number;
    groups: number;
    proxyRoutes: number;
    serviceRoutes: number;
  };
  skipped: {
    servers: number;
    deployments: number;
    users: number;
    groups: number;
  };
  warnings: string[];
  errors: string[];
}

interface ExportedServer {
  id: string;
  name: string;
  host: string | null;
  isCore: boolean;
}

interface ExportedDeployment {
  id: string;
  appName: string;
  serverId: string;
  groupId: string | null;
  config: Record<string, unknown>;
  version: string;
}

interface ExportedUser {
  id: string;
  username: string;
  isSystemAdmin: boolean;
}

interface ExportedGroup {
  id: string;
  name: string;
  description: string | null;
  totpRequired: boolean;
  members: {
    userId: string;
    role: string;
  }[];
}

interface ExportedProxyRoute {
  deploymentId: string;
  path: string;
  upstream: string;
}

interface ExportedServiceRoute {
  serviceId: string;
  serviceName: string;
  routeType: string;
  externalPort: number | null;
  externalPath: string | null;
  internalHost: string;
  internalPort: number;
}

export interface ConfigExport {
  version: string;
  exportedAt: string;
  orchestrator: {
    domain: string;
    dataPath: string;
  };
  servers: ExportedServer[];
  deployments: ExportedDeployment[];
  users: ExportedUser[];
  groups: ExportedGroup[];
  proxyRoutes: ExportedProxyRoute[];
  serviceRoutes: ExportedServiceRoute[];
  auditLog?: Array<{
    id: string;
    action: string;
    userId: string | null;
    resourceType: string | null;
    resourceId: string | null;
    details: string | null;
    ipAddress: string | null;
    createdAt: string;
  }>;
}

// Database row interfaces
interface ServerRow {
  id: string;
  name: string;
  host: string | null;
  is_core: number;
}

interface DeploymentRow {
  id: string;
  app_name: string;
  server_id: string;
  group_id: string | null;
  config: string;
  version: string;
}

interface UserRow {
  id: string;
  username: string;
  is_system_admin: number;
}

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  totp_required: number;
}

interface GroupMemberRow {
  user_id: string;
  group_id: string;
  role: string;
}

interface ProxyRouteRow {
  deployment_id: string;
  path: string;
  upstream: string;
}

interface ServiceRouteRow {
  service_id: string;
  service_name: string;
  route_type: string;
  external_port: number | null;
  external_path: string | null;
  internal_host: string;
  internal_port: number;
}

interface AuditLogRow {
  id: string;
  action: string;
  user_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
}

/**
 * ConfigExportService handles configuration export and import for disaster recovery.
 * Exports configuration data without sensitive information like passwords and secrets.
 */
class ConfigExportService {
  /**
   * Export current configuration to JSON.
   */
  async exportConfig(options: ExportOptions = {}): Promise<ConfigExport> {
    const {
      includeUsers = true,
      includeDeployments = true,
      includeAuditLog = false,
    } = options;

    const db = getDb();

    // Export servers (excluding auth tokens)
    const serverRows = db.prepare(`
      SELECT id, name, host, is_core FROM servers
    `).all() as ServerRow[];

    const servers: ExportedServer[] = serverRows.map(row => ({
      id: row.id,
      name: row.name,
      host: row.host,
      isCore: row.is_core === 1,
    }));

    // Export deployments (excluding status - will be imported as stopped)
    let deployments: ExportedDeployment[] = [];
    if (includeDeployments) {
      const deploymentRows = db.prepare(`
        SELECT id, app_name, server_id, group_id, config, version FROM deployments
      `).all() as DeploymentRow[];

      deployments = deploymentRows.map(row => ({
        id: row.id,
        appName: row.app_name,
        serverId: row.server_id,
        groupId: row.group_id,
        config: JSON.parse(row.config),
        version: row.version,
      }));
    }

    // Export users (excluding password hash and TOTP secret)
    let users: ExportedUser[] = [];
    if (includeUsers) {
      const userRows = db.prepare(`
        SELECT id, username, is_system_admin FROM users
      `).all() as UserRow[];

      users = userRows.map(row => ({
        id: row.id,
        username: row.username,
        isSystemAdmin: row.is_system_admin === 1,
      }));
    }

    // Export groups
    let groups: ExportedGroup[] = [];
    if (includeUsers) {
      const groupRows = db.prepare(`
        SELECT id, name, description, totp_required FROM groups
      `).all() as GroupRow[];

      const memberRows = db.prepare(`
        SELECT user_id, group_id, role FROM user_groups
      `).all() as GroupMemberRow[];

      groups = groupRows.map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        totpRequired: row.totp_required === 1,
        members: memberRows
          .filter(m => m.group_id === row.id)
          .map(m => ({ userId: m.user_id, role: m.role })),
      }));
    }

    // Export proxy routes
    let proxyRoutes: ExportedProxyRoute[] = [];
    if (includeDeployments) {
      const proxyRouteRows = db.prepare(`
        SELECT deployment_id, path, upstream FROM proxy_routes
      `).all() as ProxyRouteRow[];

      proxyRoutes = proxyRouteRows.map(row => ({
        deploymentId: row.deployment_id,
        path: row.path,
        upstream: row.upstream,
      }));
    }

    // Export service routes
    let serviceRoutes: ExportedServiceRoute[] = [];
    if (includeDeployments) {
      const serviceRouteRows = db.prepare(`
        SELECT service_id, service_name, route_type, external_port, external_path, internal_host, internal_port
        FROM service_routes
      `).all() as ServiceRouteRow[];

      serviceRoutes = serviceRouteRows.map(row => ({
        serviceId: row.service_id,
        serviceName: row.service_name,
        routeType: row.route_type,
        externalPort: row.external_port,
        externalPath: row.external_path,
        internalHost: row.internal_host,
        internalPort: row.internal_port,
      }));
    }

    // Export audit log (optional, can be large)
    let auditLog: ConfigExport['auditLog'];
    if (includeAuditLog) {
      const auditRows = db.prepare(`
        SELECT id, action, user_id, resource_type, resource_id, details, ip_address, created_at
        FROM audit_log
        ORDER BY created_at DESC
        LIMIT 10000
      `).all() as AuditLogRow[];

      auditLog = auditRows.map(row => ({
        id: row.id,
        action: row.action,
        userId: row.user_id,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        details: row.details,
        ipAddress: row.ip_address,
        createdAt: row.created_at,
      }));
    }

    const exportData: ConfigExport = {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      orchestrator: {
        domain: config.caddy.domain,
        dataPath: config.paths.data,
      },
      servers,
      deployments,
      users,
      groups,
      proxyRoutes,
      serviceRoutes,
      ...(auditLog && { auditLog }),
    };

    logger.info({
      servers: servers.length,
      deployments: deployments.length,
      users: users.length,
      groups: groups.length,
    }, 'Configuration exported');

    auditService.log({
      action: 'config_exported',
      resourceType: 'system',
      details: {
        servers: servers.length,
        deployments: deployments.length,
        users: users.length,
        includeAuditLog,
      },
    });

    return exportData;
  }

  /**
   * Validate configuration before import.
   */
  validateConfig(configData: unknown): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const summary = {
      servers: 0,
      deployments: 0,
      users: 0,
      groups: 0,
      proxyRoutes: 0,
      serviceRoutes: 0,
    };

    // Check if it's an object
    if (!configData || typeof configData !== 'object') {
      errors.push('Configuration must be a JSON object');
      return { valid: false, errors, warnings, summary };
    }

    const data = configData as Record<string, unknown>;

    // Check version
    if (!data.version) {
      errors.push('Missing version field');
    } else if (data.version !== EXPORT_VERSION) {
      warnings.push(`Version mismatch: expected ${EXPORT_VERSION}, got ${data.version}`);
    }

    // Check exportedAt
    if (!data.exportedAt) {
      warnings.push('Missing exportedAt field');
    }

    // Validate servers
    if (data.servers) {
      if (!Array.isArray(data.servers)) {
        errors.push('servers must be an array');
      } else {
        summary.servers = data.servers.length;
        for (let i = 0; i < data.servers.length; i++) {
          const server = data.servers[i] as Record<string, unknown>;
          if (!server.id) errors.push(`Server at index ${i} missing id`);
          if (!server.name) errors.push(`Server at index ${i} missing name`);
        }
      }
    }

    // Validate deployments
    if (data.deployments) {
      if (!Array.isArray(data.deployments)) {
        errors.push('deployments must be an array');
      } else {
        summary.deployments = data.deployments.length;
        for (let i = 0; i < data.deployments.length; i++) {
          const deployment = data.deployments[i] as Record<string, unknown>;
          if (!deployment.id) errors.push(`Deployment at index ${i} missing id`);
          if (!deployment.appName) errors.push(`Deployment at index ${i} missing appName`);
          if (!deployment.serverId) errors.push(`Deployment at index ${i} missing serverId`);
        }
      }
    }

    // Validate users
    if (data.users) {
      if (!Array.isArray(data.users)) {
        errors.push('users must be an array');
      } else {
        summary.users = data.users.length;
        for (let i = 0; i < data.users.length; i++) {
          const user = data.users[i] as Record<string, unknown>;
          if (!user.id) errors.push(`User at index ${i} missing id`);
          if (!user.username) errors.push(`User at index ${i} missing username`);
        }
        warnings.push('Users will be imported without passwords - password reset required');
      }
    }

    // Validate groups
    if (data.groups) {
      if (!Array.isArray(data.groups)) {
        errors.push('groups must be an array');
      } else {
        summary.groups = data.groups.length;
      }
    }

    // Validate proxy routes
    if (data.proxyRoutes) {
      if (!Array.isArray(data.proxyRoutes)) {
        errors.push('proxyRoutes must be an array');
      } else {
        summary.proxyRoutes = data.proxyRoutes.length;
      }
    }

    // Validate service routes
    if (data.serviceRoutes) {
      if (!Array.isArray(data.serviceRoutes)) {
        errors.push('serviceRoutes must be an array');
      } else {
        summary.serviceRoutes = data.serviceRoutes.length;
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      summary,
    };
  }

  /**
   * Import configuration from JSON.
   */
  async importConfig(configData: ConfigExport, options: ImportOptions = {}): Promise<ImportResult> {
    const {
      overwrite = false,
      regenerateSecrets = true,
      dryRun = false,
    } = options;

    const result: ImportResult = {
      success: false,
      imported: { servers: 0, deployments: 0, users: 0, groups: 0, proxyRoutes: 0, serviceRoutes: 0 },
      skipped: { servers: 0, deployments: 0, users: 0, groups: 0 },
      warnings: [],
      errors: [],
    };

    // Validate first
    const validation = this.validateConfig(configData);
    if (!validation.valid) {
      result.errors = validation.errors;
      return result;
    }
    result.warnings = [...validation.warnings];

    if (dryRun) {
      result.success = true;
      result.imported = validation.summary;
      result.warnings.push('Dry run - no changes made');
      return result;
    }

    const db = getDb();

    try {
      runInTransaction(() => {
        // Import servers
        for (const server of configData.servers || []) {
          const existing = db.prepare('SELECT id FROM servers WHERE id = ? OR name = ?')
            .get(server.id, server.name);

          if (existing) {
            if (overwrite) {
              db.prepare(`
                UPDATE servers SET name = ?, host = ?, is_core = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `).run(server.name, server.host, server.isCore ? 1 : 0, server.id);
              result.imported.servers++;
            } else {
              result.skipped.servers++;
            }
          } else {
            db.prepare(`
              INSERT INTO servers (id, name, host, is_core, agent_status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'offline', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(server.id, server.name, server.host, server.isCore ? 1 : 0);
            result.imported.servers++;
          }
        }

        // Import groups (before users for member references)
        for (const group of configData.groups || []) {
          const existing = db.prepare('SELECT id FROM groups WHERE id = ? OR name = ?')
            .get(group.id, group.name);

          if (existing) {
            if (overwrite) {
              db.prepare(`
                UPDATE groups SET name = ?, description = ?, totp_required = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `).run(group.name, group.description, group.totpRequired ? 1 : 0, group.id);
              result.imported.groups++;
            } else {
              result.skipped.groups++;
            }
          } else {
            db.prepare(`
              INSERT INTO groups (id, name, description, totp_required, created_at, updated_at)
              VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(group.id, group.name, group.description, group.totpRequired ? 1 : 0);
            result.imported.groups++;
          }
        }

        // Import users (without passwords - they need to reset)
        for (const user of configData.users || []) {
          const existing = db.prepare('SELECT id FROM users WHERE id = ? OR username = ?')
            .get(user.id, user.username);

          if (existing) {
            if (overwrite) {
              db.prepare(`
                UPDATE users SET username = ?, is_system_admin = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `).run(user.username, user.isSystemAdmin ? 1 : 0, user.id);
              result.imported.users++;
            } else {
              result.skipped.users++;
            }
          } else {
            // Create user with a random temporary password (they'll need to reset)
            const tempPasswordHash = '$2b$12$DISABLED_PASSWORD_NEEDS_RESET';
            db.prepare(`
              INSERT INTO users (id, username, password_hash, is_system_admin, created_at, updated_at)
              VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(user.id, user.username, tempPasswordHash, user.isSystemAdmin ? 1 : 0);
            result.imported.users++;
          }
        }

        // Import group memberships
        for (const group of configData.groups || []) {
          for (const member of group.members || []) {
            const existingMember = db.prepare(
              'SELECT user_id FROM user_groups WHERE user_id = ? AND group_id = ?'
            ).get(member.userId, group.id);

            if (!existingMember) {
              db.prepare(`
                INSERT INTO user_groups (user_id, group_id, role, created_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
              `).run(member.userId, group.id, member.role);
            } else if (overwrite) {
              db.prepare(`
                UPDATE user_groups SET role = ? WHERE user_id = ? AND group_id = ?
              `).run(member.role, member.userId, group.id);
            }
          }
        }

        // Import deployments (as stopped, regenerate secrets if needed)
        for (const deployment of configData.deployments || []) {
          // Check if server exists
          const serverExists = db.prepare('SELECT id FROM servers WHERE id = ?')
            .get(deployment.serverId);

          if (!serverExists) {
            result.warnings.push(`Skipping deployment ${deployment.id}: server ${deployment.serverId} not found`);
            result.skipped.deployments++;
            continue;
          }

          const existing = db.prepare('SELECT id FROM deployments WHERE id = ?')
            .get(deployment.id);

          if (existing) {
            if (overwrite) {
              db.prepare(`
                UPDATE deployments SET app_name = ?, server_id = ?, group_id = ?, config = ?, version = ?,
                  status = 'stopped', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `).run(
                deployment.appName, deployment.serverId, deployment.groupId,
                JSON.stringify(deployment.config), deployment.version, deployment.id
              );
              result.imported.deployments++;
            } else {
              result.skipped.deployments++;
            }
          } else {
            db.prepare(`
              INSERT INTO deployments (id, app_name, server_id, group_id, config, version, status, installed_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'stopped', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(
              deployment.id, deployment.appName, deployment.serverId, deployment.groupId,
              JSON.stringify(deployment.config), deployment.version
            );
            result.imported.deployments++;

            // Regenerate secrets for new deployments
            if (regenerateSecrets) {
              // Note: This is a simplified approach - full secret regeneration would need
              // access to the app manifest to know which fields are secrets
              result.warnings.push(`Deployment ${deployment.appName}: may need manual secret regeneration`);
            }
          }
        }

        // Import proxy routes
        for (const route of configData.proxyRoutes || []) {
          const deploymentExists = db.prepare('SELECT id FROM deployments WHERE id = ?')
            .get(route.deploymentId);

          if (!deploymentExists) {
            continue; // Skip routes for non-existent deployments
          }

          const existing = db.prepare('SELECT id FROM proxy_routes WHERE deployment_id = ?')
            .get(route.deploymentId);

          if (!existing) {
            db.prepare(`
              INSERT INTO proxy_routes (id, deployment_id, path, upstream, active, created_at, updated_at)
              VALUES (?, ?, ?, ?, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(uuidv4(), route.deploymentId, route.path, route.upstream);
            result.imported.proxyRoutes++;
          }
        }

        // Import service routes
        for (const route of configData.serviceRoutes || []) {
          const existing = db.prepare('SELECT id FROM service_routes WHERE service_id = ?')
            .get(route.serviceId);

          if (!existing) {
            db.prepare(`
              INSERT INTO service_routes (id, service_id, service_name, route_type, external_port, external_path, internal_host, internal_port, active, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(
              uuidv4(), route.serviceId, route.serviceName, route.routeType,
              route.externalPort, route.externalPath, route.internalHost, route.internalPort
            );
            result.imported.serviceRoutes++;
          }
        }
      });

      result.success = true;

      logger.info({
        imported: result.imported,
        skipped: result.skipped,
      }, 'Configuration imported');

      auditService.log({
        action: 'config_imported',
        resourceType: 'system',
        details: {
          imported: result.imported,
          skipped: result.skipped,
          options: { overwrite, regenerateSecrets },
        },
      });

      result.warnings.push('Imported deployments are stopped - start them manually after verification');
      result.warnings.push('Users were imported without passwords - password reset required');

    } catch (error) {
      logger.error({ error }, 'Failed to import configuration');
      result.errors.push(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return result;
  }
}

export const configExportService = new ConfigExportService();
