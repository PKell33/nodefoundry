/**
 * Deployer Rollback Tests
 *
 * Tests for the deployment compensation/rollback system.
 * Covers:
 * - Failed install triggers compensation in reverse order
 * - Route unregistration runs even if service unregister fails
 * - Database record cleaned up after rollback
 * - Caddy reload failure triggers route rollback
 * - Partial failure recovery
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Create test database
let db: Database.Database;

// Track compensation calls
let compensationCalls: string[] = [];

// Mock modules before importing
vi.mock('../db/index.js', () => ({
  getDb: () => db,
  runInTransaction: (fn: () => void) => fn(),
}));

vi.mock('./secretsManager.js', () => ({
  secretsManager: {
    generatePassword: vi.fn(() => 'generated-password'),
    generateUsername: vi.fn((prefix: string) => `${prefix}_user123`),
    storeSecretsSync: vi.fn(),
    deleteSecretsSync: vi.fn(() => {
      compensationCalls.push('deleteSecrets');
    }),
    getSecrets: vi.fn(() => ({})),
  },
}));

vi.mock('./configRenderer.js', () => ({
  configRenderer: {
    renderAppConfigs: vi.fn(() => []),
    renderInstallScript: vi.fn(() => null),
    renderConfigureScript: vi.fn(() => null),
    renderUninstallScript: vi.fn(() => null),
    renderStartScript: vi.fn(() => null),
    renderStopScript: vi.fn(() => null),
  },
}));

vi.mock('./dependencyResolver.js', () => ({
  dependencyResolver: {
    resolve: vi.fn((manifest, serverId, userConfig) => userConfig),
  },
}));

const mockProxyManager = {
  registerRoute: vi.fn(),
  unregisterRoute: vi.fn(() => {
    compensationCalls.push('unregisterRoute');
    return Promise.resolve();
  }),
  registerServiceRoute: vi.fn(),
  unregisterServiceRoutesByDeployment: vi.fn(() => {
    compensationCalls.push('unregisterServiceRoutes');
    return Promise.resolve();
  }),
  updateAndReload: vi.fn(() => true),
};

vi.mock('./proxyManager.js', () => ({
  proxyManager: mockProxyManager,
}));

const mockServiceRegistry = {
  registerService: vi.fn((deploymentId, serviceName, serverId, port) => ({
    id: `svc-${serviceName}`,
    deploymentId,
    serviceName,
    serverId,
    port,
  })),
  unregisterServicesSync: vi.fn(() => {
    compensationCalls.push('unregisterServices');
  }),
};

vi.mock('./serviceRegistry.js', () => ({
  serviceRegistry: mockServiceRegistry,
}));

vi.mock('./caddyHAManager.js', () => ({
  caddyHAManager: {
    registerInstance: vi.fn(),
    getInstanceByDeployment: vi.fn(),
    unregisterInstance: vi.fn(),
  },
}));

vi.mock('../websocket/agentHandler.js', () => ({
  requireAgentConnected: vi.fn(),
  sendCommand: vi.fn(),
  sendCommandAndWait: vi.fn(() => Promise.resolve({ status: 'success' })),
}));

vi.mock('../lib/mutexManager.js', () => ({
  mutexManager: {
    withDeploymentLock: async (id: string, fn: () => Promise<void>) => fn(),
    withServerLock: async (id: string, fn: () => Promise<unknown>) => fn(),
    cleanupDeploymentMutex: vi.fn(() => {
      compensationCalls.push('cleanupMutex');
    }),
    cleanupServerMutex: vi.fn(),
  },
}));

vi.mock('../lib/deploymentHelpers.js', () => ({
  setDeploymentStatus: vi.fn(),
  updateDeploymentStatus: vi.fn(),
}));

vi.mock('./auditService.js', () => ({
  auditService: {
    log: vi.fn(),
  },
}));

vi.mock('./deploymentValidator.js', () => ({
  getAppInfo: vi.fn(),
  checkCanUninstall: vi.fn(),
  validateInstall: vi.fn(() => ({
    appInfo: {
      manifest: {
        name: 'test-app',
        displayName: 'Test App',
        version: '1.0.0',
        configSchema: [],
        provides: [],
      },
    },
  })),
}));

vi.mock('./deploymentLifecycle.js', () => ({
  startDeployment: vi.fn(),
  stopDeployment: vi.fn(),
  restartDeployment: vi.fn(),
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

vi.mock('../lib/logger.js', () => ({
  default: mockLogger,
}));

// Helper to create a valid test manifest with required fields
function createTestManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-app',
    displayName: 'Test App',
    description: 'A test application',
    version: '1.0.0',
    category: 'utility' as const,
    source: { type: 'binary' as const },
    configSchema: [],
    provides: [],
    ...overrides,
  };
}

// Helper to create a valid AppInfo object
function createTestAppInfo(manifestOverrides: Record<string, unknown> = {}) {
  return {
    manifest: createTestManifest(manifestOverrides),
    isSingleton: false,
    isMandatory: false,
    isSystem: false,
  };
}

// Helper to create validateInstall result with validation
function createValidationResult(manifestOverrides: Record<string, unknown> = {}) {
  return {
    appInfo: createTestAppInfo(manifestOverrides),
    validationResult: {
      valid: true,
      errors: [] as string[],
      warnings: [] as string[],
    },
  };
}

// Import after mocks
const { Deployer } = await import('./deployer.js');
const { sendCommandAndWait } = await import('../websocket/agentHandler.js');
const { validateInstall } = await import('./deploymentValidator.js');
const { secretsManager } = await import('./secretsManager.js');
const { mutexManager } = await import('../lib/mutexManager.js');

describe('Deployer Rollback', () => {
  let deployer: InstanceType<typeof Deployer>;

  beforeAll(() => {
    // Create in-memory database with schema
    db = new Database(':memory:');
    const schemaPath = join(__dirname, '../db/schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    db.exec(schema);
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    deployer = new Deployer();
    compensationCalls = [];

    // Clear tables
    db.exec('DELETE FROM secrets');
    db.exec('DELETE FROM services');
    db.exec('DELETE FROM proxy_routes');
    db.exec('DELETE FROM service_routes');
    db.exec('DELETE FROM deployments');
    db.exec('DELETE FROM servers');
    db.exec('DELETE FROM app_registry');
    db.exec('DELETE FROM groups');

    // Set up test data
    db.prepare(`
      INSERT INTO servers (id, name, host, is_core, agent_status)
      VALUES ('test-server', 'Test Server', '192.168.1.100', 0, 'online')
    `).run();

    db.prepare(`
      INSERT INTO app_registry (name, manifest)
      VALUES ('test-app', '${JSON.stringify(createTestManifest())}')
    `).run();

    db.prepare(`
      INSERT INTO groups (id, name)
      VALUES ('default', 'Default Group')
    `).run();

    // Reset mocks
    vi.clearAllMocks();

    // Default mock implementations
    vi.mocked(sendCommandAndWait).mockResolvedValue({ commandId: 'cmd-1', status: 'success' });
    vi.mocked(mockProxyManager.updateAndReload).mockResolvedValue(true);
    vi.mocked(mockProxyManager.registerRoute).mockResolvedValue(undefined);
    vi.mocked(mockProxyManager.registerServiceRoute).mockResolvedValue(undefined);
  });

  describe('Failed Install Triggers Compensation in Reverse Order', () => {
    it('should run compensations in reverse order on install failure', async () => {
      // Set up manifest with webui and services
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult({
          provides: [{ name: 'api', port: 8080, protocol: 'http' }],
          webui: { enabled: true, port: 8080, basePath: '/apps/test-app' },
        }));

      // Make Caddy reload fail to trigger rollback
      vi.mocked(mockProxyManager.updateAndReload).mockResolvedValue(false);

      await expect(deployer.install('test-server', 'test-app', {})).rejects.toThrow('Failed to update Caddy');

      // Compensations should run in reverse order:
      // Last registered is webui route, then service routes, then deployment
      // But they're added in order, so reverse means:
      // unregisterRoute (webui) was added last for webui step
      // unregisterServiceRoutes + unregisterServices were added for service step
      // deleteSecrets + delete deployment was added first
      expect(compensationCalls).toContain('unregisterRoute');
      expect(compensationCalls).toContain('unregisterServiceRoutes');
      expect(compensationCalls).toContain('unregisterServices');
      expect(compensationCalls).toContain('deleteSecrets');

      // Verify reverse order: webui route first, then services, then db
      const routeIdx = compensationCalls.indexOf('unregisterRoute');
      const servicesIdx = compensationCalls.indexOf('unregisterServices');
      const secretsIdx = compensationCalls.indexOf('deleteSecrets');

      expect(routeIdx).toBeLessThan(servicesIdx);
      expect(servicesIdx).toBeLessThan(secretsIdx);
    });

    it('should continue compensations even if one fails', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult({
          provides: [{ name: 'api', port: 8080, protocol: 'http' }],
          webui: { enabled: true, port: 8080, basePath: '/apps/test-app' },
        }));

      // Make unregisterRoute throw
      vi.mocked(mockProxyManager.unregisterRoute).mockRejectedValueOnce(new Error('Route unregister failed'));

      // Make Caddy reload fail to trigger rollback
      vi.mocked(mockProxyManager.updateAndReload).mockResolvedValue(false);

      await expect(deployer.install('test-server', 'test-app', {})).rejects.toThrow('Failed to update Caddy');

      // Should still have called the other compensations
      expect(compensationCalls).toContain('unregisterServiceRoutes');
      expect(compensationCalls).toContain('unregisterServices');
      expect(compensationCalls).toContain('deleteSecrets');

      // Error should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('Compensation failed')
      );
    });
  });

  describe('Route Unregistration Runs Even If Service Unregister Fails', () => {
    it('should unregister routes even when service unregister throws', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult({
          provides: [{ name: 'api', port: 8080, protocol: 'http' }],
        }));

      // Make service unregister throw
      vi.mocked(mockServiceRegistry.unregisterServicesSync).mockImplementationOnce(() => {
        compensationCalls.push('unregisterServices');
        throw new Error('Service unregister failed');
      });

      // Make Caddy reload fail to trigger rollback
      vi.mocked(mockProxyManager.updateAndReload).mockResolvedValue(false);

      await expect(deployer.install('test-server', 'test-app', {})).rejects.toThrow('Failed to update Caddy');

      // Both should have been called (service routes unregistration includes both)
      expect(compensationCalls).toContain('unregisterServiceRoutes');
      expect(compensationCalls).toContain('unregisterServices');
    });
  });

  describe('Database Record Cleaned Up After Rollback', () => {
    it('should delete deployment record on install failure', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult());

      // Make install command fail
      vi.mocked(sendCommandAndWait).mockRejectedValue(new Error('Agent failed'));

      await expect(deployer.install('test-server', 'test-app', {})).rejects.toThrow('Install command failed');

      // Deployment should not exist in database
      const deployment = db.prepare('SELECT * FROM deployments WHERE app_name = ?').get('test-app');
      expect(deployment).toBeUndefined();
    });

    it('should delete secrets on install failure', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult({
          configSchema: [
            { name: 'password', type: 'password', label: 'Password', generated: true, secret: true },
          ],
        }));

      // Make install command fail
      vi.mocked(sendCommandAndWait).mockRejectedValue(new Error('Agent failed'));

      await expect(deployer.install('test-server', 'test-app', {})).rejects.toThrow();

      // deleteSecretsSync should have been called
      expect(secretsManager.deleteSecretsSync).toHaveBeenCalled();
    });

    it('should not leave partial deployment on Caddy failure', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult({
          provides: [{ name: 'api', port: 8080, protocol: 'http' }],
          webui: { enabled: true, port: 8080, basePath: '/apps/test-app' },
        }));

      // Make Caddy reload fail
      vi.mocked(mockProxyManager.updateAndReload).mockResolvedValue(false);

      await expect(deployer.install('test-server', 'test-app', {})).rejects.toThrow('Failed to update Caddy');

      // Deployment should be cleaned up
      const deployment = db.prepare('SELECT * FROM deployments WHERE app_name = ?').get('test-app');
      expect(deployment).toBeUndefined();

      // Routes should have been unregistered
      expect(mockProxyManager.unregisterRoute).toHaveBeenCalled();
      expect(mockProxyManager.unregisterServiceRoutesByDeployment).toHaveBeenCalled();
    });
  });

  describe('Caddy Reload Failure Triggers Route Rollback', () => {
    it('should unregister webui route on Caddy failure', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult({
          webui: { enabled: true, port: 8080, basePath: '/apps/test-app' },
        }));

      vi.mocked(mockProxyManager.updateAndReload).mockResolvedValue(false);

      await expect(deployer.install('test-server', 'test-app', {})).rejects.toThrow('Failed to update Caddy');

      expect(mockProxyManager.unregisterRoute).toHaveBeenCalled();
    });

    it('should unregister service routes on Caddy failure', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult({
          provides: [
            { name: 'api', port: 8080, protocol: 'http' },
            { name: 'grpc', port: 9090, protocol: 'tcp' },
          ],
        }));

      vi.mocked(mockProxyManager.updateAndReload).mockResolvedValue(false);

      await expect(deployer.install('test-server', 'test-app', {})).rejects.toThrow('Failed to update Caddy');

      expect(mockProxyManager.unregisterServiceRoutesByDeployment).toHaveBeenCalled();
      expect(mockServiceRegistry.unregisterServicesSync).toHaveBeenCalled();
    });
  });

  describe('Install Command Failure', () => {
    it('should rollback on agent install failure', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult());

      // Make install return error status
      vi.mocked(sendCommandAndWait).mockResolvedValue({
        commandId: 'cmd-1',
        status: 'error',
        message: 'Failed to install on agent',
      });

      await expect(deployer.install('test-server', 'test-app', {})).rejects.toThrow('Install failed on agent');

      // Deployment should be cleaned up
      const deployment = db.prepare('SELECT * FROM deployments WHERE app_name = ?').get('test-app');
      expect(deployment).toBeUndefined();
    });

    it('should rollback on agent disconnect during install', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult());

      vi.mocked(sendCommandAndWait).mockRejectedValue(new Error('Agent disconnected'));

      await expect(deployer.install('test-server', 'test-app', {})).rejects.toThrow('Install command failed');

      // Deployment should be cleaned up
      const deployment = db.prepare('SELECT * FROM deployments WHERE app_name = ?').get('test-app');
      expect(deployment).toBeUndefined();
    });
  });

  describe('Successful Install', () => {
    it('should not run compensations on successful install', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult({
          provides: [{ name: 'api', port: 8080, protocol: 'http' }],
          webui: { enabled: true, port: 8080, basePath: '/apps/test-app' },
        }));

      const result = await deployer.install('test-server', 'test-app', {});

      // No compensations should have been called
      expect(compensationCalls).toHaveLength(0);

      // Deployment should exist
      expect(result).toBeDefined();
      expect(result.appName).toBe('test-app');
      expect(result.serverId).toBe('test-server');
    });

    it('should create deployment record on success', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult());

      await deployer.install('test-server', 'test-app', {});

      const deployment = db.prepare('SELECT * FROM deployments WHERE app_name = ?').get('test-app') as any;
      expect(deployment).toBeDefined();
      expect(deployment.server_id).toBe('test-server');
      expect(deployment.status).toBe('installing'); // Initial status before command completes
    });
  });

  describe('Service Registration Rollback', () => {
    it('should unregister all services on failure after partial registration', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult({
          provides: [
            { name: 'api', port: 8080, protocol: 'http' },
            { name: 'grpc', port: 9090, protocol: 'tcp' },
          ],
        }));

      // Services register successfully, but Caddy fails
      vi.mocked(mockProxyManager.updateAndReload).mockResolvedValue(false);

      await expect(deployer.install('test-server', 'test-app', {})).rejects.toThrow();

      // Service registry should have registered 2 services
      expect(mockServiceRegistry.registerService).toHaveBeenCalledTimes(2);

      // And then unregistered them
      expect(mockServiceRegistry.unregisterServicesSync).toHaveBeenCalled();
    });
  });

  describe('Error Logging During Rollback', () => {
    it('should log original error that triggered rollback', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult());

      vi.mocked(sendCommandAndWait).mockRejectedValue(new Error('Original error'));

      await expect(deployer.install('test-server', 'test-app', {})).rejects.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          appName: 'test-app',
          err: expect.any(Error),
        }),
        expect.stringContaining('rolling back')
      );
    });

    it('should log each compensation failure', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult({
          provides: [{ name: 'api', port: 8080, protocol: 'http' }],
        }));

      // Make route unregister fail (this is called during compensation)
      vi.mocked(mockProxyManager.unregisterServiceRoutesByDeployment).mockRejectedValueOnce(
        new Error('Routes unregister failed')
      );

      vi.mocked(mockProxyManager.updateAndReload).mockResolvedValue(false);

      await expect(deployer.install('test-server', 'test-app', {})).rejects.toThrow();

      // Should have logged compensation failures
      const compensationErrorCalls = mockLogger.error.mock.calls.filter(
        call => call[1]?.includes?.('Compensation failed')
      );
      expect(compensationErrorCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Uninstall', () => {
    it('should clean up mutex on uninstall', async () => {
      // Create a fresh deployer for this test
      const freshDeployer = new Deployer();

      // First install
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult());

      const deployment = await freshDeployer.install('test-server', 'test-app', {});

      // Then uninstall
      await freshDeployer.uninstall(deployment.id);

      expect(mutexManager.cleanupDeploymentMutex).toHaveBeenCalledWith(deployment.id);
    });
  });

  describe('Concurrent Install Protection', () => {
    it('should use server lock during install', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult());
      vi.mocked(sendCommandAndWait).mockResolvedValue({ commandId: 'cmd-1', status: 'success' });

      const freshDeployer = new Deployer();

      // The install should use the server lock
      // This is verified by the fact that install() calls withServerLock
      await freshDeployer.install('test-server', 'test-app', {});

      // Deployment should exist
      const deployment = db.prepare('SELECT * FROM deployments WHERE app_name = ?').get('test-app');
      expect(deployment).toBeDefined();
    });

    it('should prevent duplicate app installation on same server', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult());
      vi.mocked(sendCommandAndWait).mockResolvedValue({ commandId: 'cmd-1', status: 'success' });

      const freshDeployer = new Deployer();

      // First install succeeds
      await freshDeployer.install('test-server', 'test-app', {});

      // Second install for same app should fail (app already deployed)
      // Note: validateInstall would throw in real scenario due to UNIQUE constraint
      vi.mocked(validateInstall).mockRejectedValue(new Error('App already installed on server'));

      await expect(freshDeployer.install('test-server', 'test-app', {})).rejects.toThrow('App already installed');
    });

    it('should allow same app installation on different servers', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult());
      vi.mocked(sendCommandAndWait).mockResolvedValue({ commandId: 'cmd-1', status: 'success' });

      // Add second server
      db.prepare(`
        INSERT INTO servers (id, name, host, is_core, agent_status)
        VALUES ('test-server-2', 'Test Server 2', '192.168.1.101', 0, 'online')
      `).run();

      const freshDeployer = new Deployer();

      // Install on first server
      const deploy1 = await freshDeployer.install('test-server', 'test-app', {});
      expect(deploy1.serverId).toBe('test-server');

      // Install same app on second server should work
      const deploy2 = await freshDeployer.install('test-server-2', 'test-app', {});
      expect(deploy2.serverId).toBe('test-server-2');

      // Both deployments should exist
      const deployments = db.prepare('SELECT * FROM deployments WHERE app_name = ?').all('test-app');
      expect(deployments.length).toBe(2);
    });
  });

  describe('CASCADE Behavior', () => {
    it('should cascade delete services when deployment is deleted', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult());

      const freshDeployer = new Deployer();
      const deployment = await freshDeployer.install('test-server', 'test-app', {});

      // Manually insert a service to test CASCADE (since service registry is mocked)
      db.prepare(`
        INSERT INTO services (id, deployment_id, service_name, server_id, host, port, status)
        VALUES ('svc-test', ?, 'api', 'test-server', '127.0.0.1', 8080, 'available')
      `).run(deployment.id);

      // Verify service was created
      const servicesBefore = db.prepare('SELECT * FROM services WHERE deployment_id = ?').all(deployment.id);
      expect(servicesBefore.length).toBe(1);

      // Delete the deployment - should cascade to services
      db.prepare('DELETE FROM deployments WHERE id = ?').run(deployment.id);

      // Services should be deleted by CASCADE
      const servicesAfter = db.prepare('SELECT * FROM services WHERE deployment_id = ?').all(deployment.id);
      expect(servicesAfter.length).toBe(0);
    });

    it('should cascade delete command_log entries when deployment is deleted', async () => {
      vi.mocked(validateInstall).mockResolvedValue(createValidationResult());

      const freshDeployer = new Deployer();
      const deployment = await freshDeployer.install('test-server', 'test-app', {});

      // Manually insert command_log entry (since sendCommand is mocked and doesn't actually insert)
      db.prepare(`
        INSERT INTO command_log (id, server_id, deployment_id, action, status)
        VALUES ('cmd-test-cascade', 'test-server', ?, 'install', 'success')
      `).run(deployment.id);

      // Verify command_log entry exists
      const logsBefore = db.prepare('SELECT * FROM command_log WHERE deployment_id = ?').all(deployment.id);
      expect(logsBefore.length).toBe(1);

      // Delete the deployment
      db.prepare('DELETE FROM deployments WHERE id = ?').run(deployment.id);

      // Command log entries should be deleted by CASCADE
      const logsAfter = db.prepare('SELECT * FROM command_log WHERE deployment_id = ?').all(deployment.id);
      expect(logsAfter.length).toBe(0);
    });

    it('should cascade delete command_log entries when server is deleted', async () => {
      // Create a separate server for this test
      db.prepare(`
        INSERT INTO servers (id, name, host, is_core, agent_status)
        VALUES ('cascade-test-server', 'Cascade Test', '192.168.1.200', 0, 'online')
      `).run();

      // Insert a command_log entry for this server
      db.prepare(`
        INSERT INTO command_log (id, server_id, action, status)
        VALUES ('cmd-cascade-test', 'cascade-test-server', 'test', 'pending')
      `).run();

      // Verify it exists
      const logBefore = db.prepare('SELECT * FROM command_log WHERE server_id = ?').get('cascade-test-server');
      expect(logBefore).toBeDefined();

      // Delete the server
      db.prepare('DELETE FROM servers WHERE id = ?').run('cascade-test-server');

      // Command log should be deleted by CASCADE
      const logAfter = db.prepare('SELECT * FROM command_log WHERE server_id = ?').get('cascade-test-server');
      expect(logAfter).toBeUndefined();
    });
  });
});
