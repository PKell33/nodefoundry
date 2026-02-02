/**
 * Service route management for proxy.
 * Handles registration and state of service routes (HTTP and TCP).
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { ExistsRow } from '../../db/types.js';
import type { ServiceDefinition } from '@ownprem/shared';
import type { ServiceRoute, ServiceRouteRowWithJoins } from './proxyTypes.js';
import { TCP_PORT_RANGE_START, TCP_PORT_RANGE_END } from './proxyTypes.js';

/**
 * Allocate a TCP port for service proxying.
 */
async function allocateTcpPort(preferredPort: number): Promise<number> {
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

/**
 * Register a service route.
 * Creates the route as inactive - will be activated when app is started.
 */
export async function registerServiceRoute(
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
    // HTTP services get a path like /services/myapp-api
    externalPath = `/services/${serviceName}`;
  } else {
    // TCP services get an allocated port
    externalPort = await allocateTcpPort(upstreamPort);
  }

  // Check for existing route for this service
  const existing = db.prepare('SELECT id FROM service_routes WHERE service_id = ?').get(serviceId) as ExistsRow | undefined;

  if (existing) {
    db.prepare(`
      UPDATE service_routes
      SET route_type = ?, external_path = ?, external_port = ?, upstream_host = ?, upstream_port = ?, active = FALSE
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
    VALUES (?, ?, ?, ?, ?, ?, ?, FALSE)
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

/**
 * Unregister service routes by service ID.
 */
export async function unregisterServiceRoutes(serviceId: string): Promise<void> {
  const db = getDb();
  db.prepare('DELETE FROM service_routes WHERE service_id = ?').run(serviceId);
}

/**
 * Unregister all service routes for a deployment.
 */
export async function unregisterServiceRoutesByDeployment(deploymentId: string): Promise<void> {
  const db = getDb();
  db.prepare(`
    DELETE FROM service_routes
    WHERE service_id IN (SELECT id FROM services WHERE deployment_id = ?)
  `).run(deploymentId);
}

/**
 * Set the active state of a service route.
 */
export async function setServiceRouteActive(serviceId: string, active: boolean): Promise<void> {
  const db = getDb();
  db.prepare('UPDATE service_routes SET active = ? WHERE service_id = ?').run(active ? 1 : 0, serviceId);
}

/**
 * Set the active state of all service routes for a deployment.
 */
export async function setServiceRoutesActiveByDeployment(deploymentId: string, active: boolean): Promise<void> {
  const db = getDb();
  db.prepare(`
    UPDATE service_routes SET active = ?
    WHERE service_id IN (SELECT id FROM services WHERE deployment_id = ?)
  `).run(active ? 1 : 0, deploymentId);
}

/**
 * Get all active service routes.
 */
export async function getActiveServiceRoutes(): Promise<ServiceRoute[]> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT sr.*, svc.service_name, d.app_name, svr.name as server_name
    FROM service_routes sr
    JOIN services svc ON sr.service_id = svc.id
    JOIN deployments d ON svc.deployment_id = d.id
    JOIN servers svr ON d.server_id = svr.id
    WHERE sr.active = TRUE
    ORDER BY sr.route_type, svc.service_name
  `).all() as ServiceRouteRowWithJoins[];

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

/**
 * Get a specific service route.
 */
export async function getServiceRoute(serviceId: string): Promise<ServiceRoute | null> {
  const db = getDb();
  const row = db.prepare(`
    SELECT sr.*, svc.service_name, d.app_name, svr.name as server_name
    FROM service_routes sr
    JOIN services svc ON sr.service_id = svc.id
    JOIN deployments d ON svc.deployment_id = d.id
    JOIN servers svr ON d.server_id = svr.id
    WHERE sr.service_id = ?
  `).get(serviceId) as ServiceRouteRowWithJoins | undefined;

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
