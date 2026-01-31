/**
 * ProxyManager - facade for proxy route management.
 * Coordinates web UI routes, service routes, and Caddy configuration.
 */

import type { AppManifest, ServiceDefinition } from '@ownprem/shared';
import { config } from '../config.js';
import { createFireAndForgetDebounce } from '../lib/debounce.js';
import logger from '../lib/logger.js';

// Import from extracted modules
import type { ProxyRoute, ServiceRoute } from './proxy/proxyTypes.js';
import {
  registerWebUiRoute,
  unregisterWebUiRoute,
  setWebUiRouteActive,
  getActiveWebUiRoutes,
} from './proxy/webUiRoutes.js';
import {
  registerServiceRoute as registerServiceRouteInternal,
  unregisterServiceRoutes as unregisterServiceRoutesInternal,
  unregisterServiceRoutesByDeployment as unregisterServiceRoutesByDeploymentInternal,
  setServiceRouteActive as setServiceRouteActiveInternal,
  setServiceRoutesActiveByDeployment as setServiceRoutesActiveByDeploymentInternal,
  getActiveServiceRoutes,
  getServiceRoute as getServiceRouteInternal,
} from './proxy/serviceRoutes.js';
import {
  createCaddyState,
  generateCaddyJsonConfig,
  pushConfigToCaddy,
  resetCaddyState as resetCaddyStateInternal,
  getCaddyStatus as getCaddyStatusInternal,
  generateDevCaddyfile,
} from './proxy/caddyConfig.js';

// Re-export types for consumers
export type { ProxyRoute, ServiceRoute } from './proxy/proxyTypes.js';

export class ProxyManager {
  private apiPort: number;
  private domain: string;
  private caddyAdminUrl: string;
  private caddyState = createCaddyState();

  // Debounced reload for coalescing rapid route changes
  public scheduleReload: () => void;

  constructor(
    apiPort: number = config.port,
    domain: string = config.caddy.domain,
    caddyAdminUrl: string = config.caddy.adminUrl
  ) {
    this.apiPort = apiPort;
    this.domain = domain;
    this.caddyAdminUrl = caddyAdminUrl;

    // Create debounced reload function (2 second delay)
    // This coalesces multiple route changes into a single Caddy reload
    this.scheduleReload = createFireAndForgetDebounce(
      () => this.updateAndReload(),
      2000,
      (err) => logger.error({ err }, 'Failed to reload Caddy after debounced update')
    );
  }

  // ==================== Web UI Routes ====================

  async registerRoute(deploymentId: string, manifest: AppManifest, serverHost: string): Promise<void> {
    return registerWebUiRoute(deploymentId, manifest, serverHost);
  }

  async unregisterRoute(deploymentId: string): Promise<void> {
    return unregisterWebUiRoute(deploymentId);
  }

  async setRouteActive(deploymentId: string, active: boolean): Promise<void> {
    return setWebUiRouteActive(deploymentId, active);
  }

  async getActiveRoutes(): Promise<ProxyRoute[]> {
    return getActiveWebUiRoutes();
  }

  // ==================== Service Routes ====================

  async registerServiceRoute(
    serviceId: string,
    serviceName: string,
    serviceDef: ServiceDefinition,
    upstreamHost: string,
    upstreamPort: number
  ): Promise<ServiceRoute> {
    return registerServiceRouteInternal(serviceId, serviceName, serviceDef, upstreamHost, upstreamPort);
  }

  async unregisterServiceRoutes(serviceId: string): Promise<void> {
    return unregisterServiceRoutesInternal(serviceId);
  }

  async unregisterServiceRoutesByDeployment(deploymentId: string): Promise<void> {
    return unregisterServiceRoutesByDeploymentInternal(deploymentId);
  }

  async setServiceRouteActive(serviceId: string, active: boolean): Promise<void> {
    return setServiceRouteActiveInternal(serviceId, active);
  }

  async setServiceRoutesActiveByDeployment(deploymentId: string, active: boolean): Promise<void> {
    return setServiceRoutesActiveByDeploymentInternal(deploymentId, active);
  }

  async getActiveServiceRoutes(): Promise<ServiceRoute[]> {
    return getActiveServiceRoutes();
  }

  async getServiceRoute(serviceId: string): Promise<ServiceRoute | null> {
    return getServiceRouteInternal(serviceId);
  }

  // ==================== Caddy Admin API ====================

  async updateAndReload(): Promise<boolean> {
    const routes = await this.getActiveRoutes();
    const serviceRoutes = await this.getActiveServiceRoutes();
    const caddyConfig = await generateCaddyJsonConfig(routes, serviceRoutes, this.apiPort, this.domain);

    return pushConfigToCaddy(caddyConfig, this.caddyAdminUrl, this.caddyState);
  }

  /**
   * Reset the Caddy state to allow retrying after failures.
   */
  resetCaddyState(): void {
    resetCaddyStateInternal(this.caddyState);
  }

  /**
   * Get the current Caddy integration status.
   */
  getCaddyStatus(): { consecutiveFailures: number; hasLastGoodConfig: boolean; isCircuitOpen: boolean } {
    return getCaddyStatusInternal(this.caddyState);
  }

  /**
   * Generate development Caddyfile (for debugging/reference).
   */
  generateDevConfig(webUiRoutes: ProxyRoute[] = [], serviceRoutes: ServiceRoute[] = []): string {
    return generateDevCaddyfile(webUiRoutes, serviceRoutes, this.apiPort, this.domain);
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
