import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { dirname } from 'path';
import { getDb } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import type { AppManifest, ServiceDefinition } from '@ownprem/shared';
import { config } from '../config.js';

interface ProxyRoute {
  id: string;
  path: string;
  upstream: string;
  appName: string;
  serverName: string;
}

interface ServiceRoute {
  id: string;
  serviceId: string;
  serviceName: string;
  routeType: 'http' | 'tcp';
  externalPath?: string;
  externalPort?: number;
  upstreamHost: string;
  upstreamPort: number;
  appName: string;
  serverName: string;
}

interface ProxyRouteRow {
  id: string;
  deployment_id: string;
  path: string;
  upstream: string;
  active: number;
}

interface ServiceRouteRow {
  id: string;
  service_id: string;
  service_name: string;
  route_type: string;
  external_path: string | null;
  external_port: number | null;
  upstream_host: string;
  upstream_port: number;
  app_name: string;
  server_name: string;
}

interface DeploymentWithManifest {
  id: string;
  server_id: string;
  app_name: string;
  status: string;
  host: string | null;
  manifest: string;
  server_name: string;
}

// Port range for TCP service proxying
const TCP_PORT_RANGE_START = 50000;
const TCP_PORT_RANGE_END = 50100;

export class ProxyManager {
  private caddyfilePath: string;
  private apiPort: number;
  private domain: string;
  private reloadCommand: string;

  constructor(
    caddyfilePath: string = config.paths.caddyConfig,
    apiPort: number = config.port,
    domain: string = config.caddy.domain
  ) {
    this.caddyfilePath = caddyfilePath;
    this.apiPort = apiPort;
    this.domain = domain;
    this.reloadCommand = config.caddy.reloadCommand;
  }

  // ==================== Web UI Routes ====================

  async registerRoute(deploymentId: string, manifest: AppManifest, serverHost: string): Promise<void> {
    if (!manifest.webui?.enabled) {
      return;
    }

    const db = getDb();
    const path = manifest.webui.basePath;
    const host = serverHost || '127.0.0.1';
    const upstream = `http://${host}:${manifest.webui.port}`;

    const existing = db.prepare('SELECT id FROM proxy_routes WHERE path = ?').get(path) as { id: string } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE proxy_routes SET upstream = ?, active = TRUE, deployment_id = ?
        WHERE id = ?
      `).run(upstream, deploymentId, existing.id);
    } else {
      const id = uuidv4();
      db.prepare(`
        INSERT INTO proxy_routes (id, deployment_id, path, upstream, active)
        VALUES (?, ?, ?, ?, TRUE)
      `).run(id, deploymentId, path, upstream);
    }
  }

  async unregisterRoute(deploymentId: string): Promise<void> {
    const db = getDb();
    db.prepare('DELETE FROM proxy_routes WHERE deployment_id = ?').run(deploymentId);
  }

  async setRouteActive(deploymentId: string, active: boolean): Promise<void> {
    const db = getDb();
    db.prepare('UPDATE proxy_routes SET active = ? WHERE deployment_id = ?').run(active ? 1 : 0, deploymentId);
  }

  async getActiveRoutes(): Promise<ProxyRoute[]> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT pr.*, d.app_name, s.name as server_name
      FROM proxy_routes pr
      JOIN deployments d ON pr.deployment_id = d.id
      JOIN servers s ON d.server_id = s.id
      WHERE pr.active = TRUE
      ORDER BY pr.path
    `).all() as (ProxyRouteRow & { app_name: string; server_name: string })[];

    return rows.map(row => ({
      id: row.id,
      path: row.path,
      upstream: row.upstream,
      appName: row.app_name,
      serverName: row.server_name,
    }));
  }

  // ==================== Service Routes ====================

  async registerServiceRoute(
    serviceId: string,
    serviceName: string,
    serviceDef: ServiceDefinition,
    upstreamHost: string,
    upstreamPort: number
  ): Promise<ServiceRoute> {
    const db = getDb();
    const id = uuidv4();

    // Determine route type based on protocol
    const routeType = serviceDef.protocol === 'http' ? 'http' : 'tcp';

    let externalPath: string | undefined;
    let externalPort: number | undefined;

    if (routeType === 'http') {
      // HTTP services get a path like /services/bitcoin-rpc
      externalPath = `/services/${serviceName}`;
    } else {
      // TCP services get an allocated port
      externalPort = await this.allocateTcpPort(upstreamPort);
    }

    // Check for existing route for this service
    const existing = db.prepare('SELECT id FROM service_routes WHERE service_id = ?').get(serviceId) as { id: string } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE service_routes
        SET route_type = ?, external_path = ?, external_port = ?, upstream_host = ?, upstream_port = ?, active = TRUE
        WHERE id = ?
      `).run(routeType, externalPath || null, externalPort || null, upstreamHost, upstreamPort, existing.id);

      return {
        id: existing.id,
        serviceId,
        serviceName,
        routeType,
        externalPath,
        externalPort,
        upstreamHost,
        upstreamPort,
        appName: '',
        serverName: '',
      };
    }

    db.prepare(`
      INSERT INTO service_routes (id, service_id, route_type, external_path, external_port, upstream_host, upstream_port, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)
    `).run(id, serviceId, routeType, externalPath || null, externalPort || null, upstreamHost, upstreamPort);

    return {
      id,
      serviceId,
      serviceName,
      routeType,
      externalPath,
      externalPort,
      upstreamHost,
      upstreamPort,
      appName: '',
      serverName: '',
    };
  }

  async unregisterServiceRoutes(serviceId: string): Promise<void> {
    const db = getDb();
    db.prepare('DELETE FROM service_routes WHERE service_id = ?').run(serviceId);
  }

  async unregisterServiceRoutesByDeployment(deploymentId: string): Promise<void> {
    const db = getDb();
    db.prepare(`
      DELETE FROM service_routes
      WHERE service_id IN (SELECT id FROM services WHERE deployment_id = ?)
    `).run(deploymentId);
  }

  async setServiceRouteActive(serviceId: string, active: boolean): Promise<void> {
    const db = getDb();
    db.prepare('UPDATE service_routes SET active = ? WHERE service_id = ?').run(active ? 1 : 0, serviceId);
  }

  async getActiveServiceRoutes(): Promise<ServiceRoute[]> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT sr.*, svc.service_name, d.app_name, svr.name as server_name
      FROM service_routes sr
      JOIN services svc ON sr.service_id = svc.id
      JOIN deployments d ON svc.deployment_id = d.id
      JOIN servers svr ON d.server_id = svr.id
      WHERE sr.active = TRUE
      ORDER BY sr.route_type, svc.service_name
    `).all() as ServiceRouteRow[];

    return rows.map(row => ({
      id: row.id,
      serviceId: row.service_id,
      serviceName: row.service_name,
      routeType: row.route_type as 'http' | 'tcp',
      externalPath: row.external_path || undefined,
      externalPort: row.external_port || undefined,
      upstreamHost: row.upstream_host,
      upstreamPort: row.upstream_port,
      appName: row.app_name,
      serverName: row.server_name,
    }));
  }

  async getServiceRoute(serviceId: string): Promise<ServiceRoute | null> {
    const db = getDb();
    const row = db.prepare(`
      SELECT sr.*, svc.service_name, d.app_name, svr.name as server_name
      FROM service_routes sr
      JOIN services svc ON sr.service_id = svc.id
      JOIN deployments d ON svc.deployment_id = d.id
      JOIN servers svr ON d.server_id = svr.id
      WHERE sr.service_id = ?
    `).get(serviceId) as ServiceRouteRow | undefined;

    if (!row) return null;

    return {
      id: row.id,
      serviceId: row.service_id,
      serviceName: row.service_name,
      routeType: row.route_type as 'http' | 'tcp',
      externalPath: row.external_path || undefined,
      externalPort: row.external_port || undefined,
      upstreamHost: row.upstream_host,
      upstreamPort: row.upstream_port,
      appName: row.app_name,
      serverName: row.server_name,
    };
  }

  private async allocateTcpPort(preferredPort: number): Promise<number> {
    const db = getDb();

    // Try to use the same port as internal if available
    if (preferredPort >= TCP_PORT_RANGE_START && preferredPort <= TCP_PORT_RANGE_END) {
      const existing = db.prepare('SELECT id FROM service_routes WHERE external_port = ?').get(preferredPort);
      if (!existing) {
        return preferredPort;
      }
    }

    // Find next available port in range
    const usedPorts = db.prepare(`
      SELECT external_port FROM service_routes WHERE external_port IS NOT NULL
    `).all() as { external_port: number }[];

    const usedSet = new Set(usedPorts.map(p => p.external_port));

    for (let port = TCP_PORT_RANGE_START; port <= TCP_PORT_RANGE_END; port++) {
      if (!usedSet.has(port)) {
        return port;
      }
    }

    throw new Error('No available TCP ports for service proxying');
  }

  // ==================== Caddy Config Generation ====================

  async updateCaddyConfig(): Promise<void> {
    const routes = await this.getActiveRoutes();
    const serviceRoutes = await this.getActiveServiceRoutes();
    const config = this.generateCaddyConfig(routes, serviceRoutes);

    // Ensure directory exists
    const dir = dirname(this.caddyfilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(this.caddyfilePath, config);
    console.log(`Wrote Caddy config to ${this.caddyfilePath}`);
  }

  async reloadCaddy(): Promise<boolean> {
    if (!this.reloadCommand) {
      console.log('Caddy config updated (reload skipped in development)');
      return true;
    }

    try {
      execSync(this.reloadCommand, { stdio: 'inherit' });
      console.log('Caddy reloaded successfully');
      return true;
    } catch (err) {
      console.error('Failed to reload Caddy:', err);
      return false;
    }
  }

  async updateAndReload(): Promise<boolean> {
    await this.updateCaddyConfig();
    return this.reloadCaddy();
  }

  private generateCaddyConfig(routes: ProxyRoute[], serviceRoutes: ServiceRoute[]): string {
    // Web UI route blocks
    const webUiBlocks = routes.map(route => `
  # ${route.appName} Web UI on ${route.serverName}
  handle ${route.path}/* {
    uri strip_prefix ${route.path}
    reverse_proxy ${route.upstream}
  }`).join('\n');

    // HTTP service route blocks
    const httpServiceRoutes = serviceRoutes.filter(r => r.routeType === 'http');
    const httpServiceBlocks = httpServiceRoutes.map(route => `
  # ${route.serviceName} (${route.appName}) on ${route.serverName}
  handle ${route.externalPath}/* {
    uri strip_prefix ${route.externalPath}
    reverse_proxy http://${route.upstreamHost}:${route.upstreamPort}
  }`).join('\n');

    // TCP service routes (layer4)
    const tcpServiceRoutes = serviceRoutes.filter(r => r.routeType === 'tcp');
    const tcpBlocks = tcpServiceRoutes.map(route => `
# ${route.serviceName} (${route.appName}) TCP on ${route.serverName}
:${route.externalPort} {
  route {
    proxy ${route.upstreamHost}:${route.upstreamPort}
  }
}`).join('\n');

    // Combine HTTP and TCP configs
    const httpConfig = `# OwnPrem Caddy Configuration
# Auto-generated - do not edit manually

{
  auto_https off
}

:443 {
  tls internal

  # OwnPrem Core UI (static files)
  handle / {
    root * /opt/ownprem/ui/dist
    file_server
    try_files {path} /index.html
  }

  # OwnPrem Core API
  handle /api/* {
    reverse_proxy localhost:${this.apiPort}
  }

  # WebSocket for real-time updates
  handle /socket.io/* {
    reverse_proxy localhost:${this.apiPort}
  }

  # HTTP Service Endpoints
${httpServiceBlocks}

  # App Web UIs
${webUiBlocks}

  # Fallback to UI for SPA routing
  handle {
    root * /opt/ownprem/ui/dist
    file_server
    try_files {path} /index.html
  }
}
`;

    // Layer4 config is separate (requires layer4 module)
    const layer4Config = tcpServiceRoutes.length > 0 ? `
# ========================================
# TCP Service Proxying (requires layer4 module)
# Install: xcaddy build --with github.com/mholt/caddy-l4
# ========================================

${tcpBlocks}
` : '';

    return httpConfig + layer4Config;
  }

  generateDevConfig(serviceRoutes: ServiceRoute[] = []): string {
    const httpRoutes = serviceRoutes.filter(r => r.routeType === 'http');
    const tcpRoutes = serviceRoutes.filter(r => r.routeType === 'tcp');

    let config = `# OwnPrem Development Caddyfile
# Proxies to Vite dev server and API

{
  local_certs
}

${this.domain} {
  tls internal

  # API proxy
  handle /api/* {
    reverse_proxy localhost:${this.apiPort}
  }

  # WebSocket proxy
  handle /socket.io/* {
    reverse_proxy localhost:${this.apiPort}
  }

  # Health endpoints
  handle /health {
    reverse_proxy localhost:${this.apiPort}
  }

  handle /ready {
    reverse_proxy localhost:${this.apiPort}
  }
`;

    // Add HTTP service routes
    for (const route of httpRoutes) {
      config += `
  # ${route.serviceName} (${route.appName})
  handle ${route.externalPath}/* {
    uri strip_prefix ${route.externalPath}
    reverse_proxy http://${route.upstreamHost}:${route.upstreamPort}
  }
`;
    }

    config += `
  # Everything else to Vite dev server
  handle {
    reverse_proxy localhost:5173
  }
}
`;

    // Add TCP service routes (layer4)
    if (tcpRoutes.length > 0) {
      config += `
# ========================================
# TCP Service Proxying (requires layer4 module)
# ========================================

`;
      for (const route of tcpRoutes) {
        config += `# ${route.serviceName} (${route.appName})
:${route.externalPort} {
  route {
    proxy ${route.upstreamHost}:${route.upstreamPort}
  }
}
`;
      }
    }

    return config;
  }

  // ==================== Connection Info Helpers ====================

  getExternalUrl(serviceRoute: ServiceRoute, useTor: boolean = false): string {
    if (useTor) {
      // Tor connections bypass Caddy - handled separately
      return '';
    }

    if (serviceRoute.routeType === 'http') {
      return `https://${this.domain}${serviceRoute.externalPath}`;
    } else {
      return `${this.domain}:${serviceRoute.externalPort}`;
    }
  }
}

export const proxyManager = new ProxyManager();
