import { getDb } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import type { Service, ServiceConnection } from '@ownprem/shared';

interface ServiceRow {
  id: string;
  deployment_id: string;
  service_name: string;
  server_id: string;
  host: string;
  port: number;
  tor_address: string | null;
  status: string;
}

export interface PortConflict {
  port: number;
  serviceName: string;
  deploymentId: string;
  appName: string;
}

interface ServerRow {
  id: string;
  host: string | null;
  is_core: number;
}

export class ServiceRegistry {
  async registerService(
    deploymentId: string,
    serviceName: string,
    serverId: string,
    port: number,
    torAddress?: string
  ): Promise<Service> {
    const db = getDb();

    // Get server host
    const server = db.prepare('SELECT host, is_core FROM servers WHERE id = ?').get(serverId) as ServerRow | undefined;
    if (!server) {
      throw new Error(`Server ${serverId} not found`);
    }

    const host = server.is_core ? '127.0.0.1' : (server.host || '127.0.0.1');
    const id = uuidv4();

    db.prepare(`
      INSERT INTO services (id, deployment_id, service_name, server_id, host, port, tor_address, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'available')
      ON CONFLICT(deployment_id, service_name) DO UPDATE SET
        host = excluded.host,
        port = excluded.port,
        tor_address = excluded.tor_address,
        status = 'available'
    `).run(id, deploymentId, serviceName, serverId, host, port, torAddress || null);

    return {
      id,
      deploymentId,
      serviceName,
      serverId,
      host,
      port,
      torAddress,
      status: 'available',
    };
  }

  async unregisterServices(deploymentId: string): Promise<void> {
    this.unregisterServicesSync(deploymentId);
  }

  /**
   * Synchronous version for use in transactions
   */
  unregisterServicesSync(deploymentId: string): void {
    const db = getDb();
    db.prepare('DELETE FROM services WHERE deployment_id = ?').run(deploymentId);
  }

  async setServiceStatus(deploymentId: string, serviceName: string, status: 'available' | 'unavailable'): Promise<void> {
    const db = getDb();
    db.prepare(`
      UPDATE services SET status = ? WHERE deployment_id = ? AND service_name = ?
    `).run(status, deploymentId, serviceName);
  }

  async findService(serviceName: string): Promise<Service | null> {
    const db = getDb();
    const row = db.prepare(`
      SELECT * FROM services WHERE service_name = ? AND status = 'available' LIMIT 1
    `).get(serviceName) as ServiceRow | undefined;

    if (!row) {
      return null;
    }

    return this.rowToService(row);
  }

  async findAllServices(serviceName: string): Promise<Service[]> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM services WHERE service_name = ? AND status = 'available'
    `).all(serviceName) as ServiceRow[];

    return rows.map(row => this.rowToService(row));
  }

  async findServiceOnServer(serviceName: string, serverId: string): Promise<Service | null> {
    const db = getDb();
    const row = db.prepare(`
      SELECT * FROM services WHERE service_name = ? AND server_id = ? AND status = 'available'
    `).get(serviceName, serverId) as ServiceRow | undefined;

    if (!row) {
      return null;
    }

    return this.rowToService(row);
  }

  async getServicesByDeployment(deploymentId: string): Promise<Service[]> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM services WHERE deployment_id = ?
    `).all(deploymentId) as ServiceRow[];

    return rows.map(row => this.rowToService(row));
  }

  async getConnection(
    serviceName: string,
    consumerServerId: string,
    preferSameServer: boolean = false
  ): Promise<ServiceConnection | null> {
    const db = getDb();

    // First try to find on same server if preferred
    if (preferSameServer) {
      const sameServerService = await this.findServiceOnServer(serviceName, consumerServerId);
      if (sameServerService) {
        return {
          host: '127.0.0.1',
          port: sameServerService.port,
        };
      }
    }

    // Find any available service
    const service = await this.findService(serviceName);
    if (!service) {
      return null;
    }

    // If on same server, use localhost
    const host = service.serverId === consumerServerId ? '127.0.0.1' : service.host;

    return {
      host,
      port: service.port,
    };
  }

  async listAllServices(): Promise<Service[]> {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM services ORDER BY service_name').all() as ServiceRow[];
    return rows.map(row => this.rowToService(row));
  }

  /**
   * P1: Check for port conflicts before deployment.
   * Returns list of conflicting ports with details about which app is using them.
   */
  async checkPortConflicts(
    serverId: string,
    ports: Array<{ port: number; serviceName: string }>
  ): Promise<PortConflict[]> {
    const db = getDb();
    const conflicts: PortConflict[] = [];

    for (const { port, serviceName } of ports) {
      // Check if any service on this server is already using this port
      const existing = db.prepare(`
        SELECT s.port, s.service_name, s.deployment_id, d.app_name
        FROM services s
        JOIN deployments d ON s.deployment_id = d.id
        WHERE s.server_id = ? AND s.port = ?
      `).get(serverId, port) as { port: number; service_name: string; deployment_id: string; app_name: string } | undefined;

      if (existing) {
        conflicts.push({
          port: existing.port,
          serviceName: existing.service_name,
          deploymentId: existing.deployment_id,
          appName: existing.app_name,
        });
      }
    }

    return conflicts;
  }

  private rowToService(row: ServiceRow): Service {
    return {
      id: row.id,
      deploymentId: row.deployment_id,
      serviceName: row.service_name,
      serverId: row.server_id,
      host: row.host,
      port: row.port,
      torAddress: row.tor_address || undefined,
      status: row.status as 'available' | 'unavailable',
    };
  }
}

export const serviceRegistry = new ServiceRegistry();
