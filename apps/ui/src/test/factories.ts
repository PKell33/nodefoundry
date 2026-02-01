/**
 * Mock Data Factories for Testing
 *
 * These factories create realistic mock data for testing components and hooks.
 * All factories support partial overrides for customization.
 */

import type { Server, Deployment, AppManifest, SystemStatus, UserInfo } from '../api/client';

// ============================================================================
// Server Factories
// ============================================================================

let serverIdCounter = 1;

export function createMockServer(overrides: Partial<Server> = {}): Server {
  const id = overrides.id || `server-${serverIdCounter++}`;
  return {
    id,
    name: overrides.name || `Test Server ${id}`,
    host: overrides.host || `192.168.1.${100 + serverIdCounter}`,
    isCore: overrides.isCore ?? false,
    agentStatus: overrides.agentStatus || 'online',
    lastSeen: overrides.lastSeen || new Date().toISOString(),
    createdAt: overrides.createdAt || new Date().toISOString(),
    metrics: overrides.metrics,
    ...overrides,
  };
}

export function createMockServers(count: number, overrides: Partial<Server> = {}): Server[] {
  return Array.from({ length: count }, (_, i) =>
    createMockServer({
      id: `server-${i + 1}`,
      name: `Server ${i + 1}`,
      host: `192.168.1.${100 + i}`,
      ...overrides,
    })
  );
}

export function createCoreServer(overrides: Partial<Server> = {}): Server {
  return createMockServer({
    id: 'core',
    name: 'Core Server',
    host: 'localhost',
    isCore: true,
    agentStatus: 'online',
    ...overrides,
  });
}

// ============================================================================
// Deployment Factories
// ============================================================================

let deploymentIdCounter = 1;

export function createMockDeployment(overrides: Partial<Deployment> = {}): Deployment {
  const id = overrides.id || `deployment-${deploymentIdCounter++}`;
  return {
    id,
    serverId: overrides.serverId || 'server-1',
    appName: overrides.appName || 'mock-app',
    version: overrides.version || '1.0.0',
    status: overrides.status || 'running',
    config: overrides.config || {},
    installedAt: overrides.installedAt || new Date().toISOString(),
    updatedAt: overrides.updatedAt || new Date().toISOString(),
    ...overrides,
  };
}

export function createMockDeployments(count: number, overrides: Partial<Deployment> = {}): Deployment[] {
  return Array.from({ length: count }, (_, i) =>
    createMockDeployment({
      id: `deployment-${i + 1}`,
      appName: `app-${i + 1}`,
      ...overrides,
    })
  );
}

// ============================================================================
// App Factories
// ============================================================================

export function createMockApp(overrides: Partial<AppManifest> = {}): AppManifest {
  const name = overrides.name || 'mock-app';
  return {
    name,
    displayName: overrides.displayName || name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' '),
    version: overrides.version || '1.0.0',
    description: overrides.description || `A ${name} application for testing`,
    category: overrides.category || 'web',
    source: overrides.source || { type: 'git', gitUrl: `https://github.com/example/${name}` },
    requires: overrides.requires || [],
    provides: overrides.provides || [],
    configSchema: overrides.configSchema || [],
    mandatory: overrides.mandatory,
    ...overrides,
  };
}

export function createMockApps(names: string[]): AppManifest[] {
  return names.map(name => createMockApp({ name }));
}

// ============================================================================
// System Status Factories
// ============================================================================

export function createMockSystemStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    status: overrides.status || 'ok',
    servers: overrides.servers || { total: 2, online: 2 },
    deployments: overrides.deployments || { total: 5, running: 4 },
    timestamp: overrides.timestamp || new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// User Factories
// ============================================================================

let userIdCounter = 1;

export function createMockUser(overrides: Partial<UserInfo> = {}): UserInfo {
  const id = overrides.id || `user-${userIdCounter++}`;
  return {
    id,
    username: overrides.username || `testuser${userIdCounter}`,
    is_system_admin: overrides.is_system_admin ?? false,
    totp_enabled: overrides.totp_enabled ?? false,
    created_at: overrides.created_at || new Date().toISOString(),
    last_login_at: overrides.last_login_at || null,
    groups: overrides.groups || [],
    ...overrides,
  };
}

export function createMockUsers(count: number, overrides: Partial<UserInfo> = {}): UserInfo[] {
  return Array.from({ length: count }, (_, i) =>
    createMockUser({
      id: `user-${i + 1}`,
      username: `user${i + 1}`,
      ...overrides,
    })
  );
}

export function createMockAdminUser(overrides: Partial<UserInfo> = {}): UserInfo {
  return createMockUser({
    username: 'admin',
    is_system_admin: true,
    totp_enabled: true,
    ...overrides,
  });
}

// ============================================================================
// Auth Store Mock State Factories
// ============================================================================

export interface MockAuthState {
  user: {
    userId: string;
    username: string;
    isSystemAdmin: boolean;
    groups?: Array<{ groupId: string; groupName: string; role: string }>;
  } | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}

export function createMockAuthState(overrides: Partial<MockAuthState> = {}): MockAuthState {
  return {
    user: overrides.user ?? {
      userId: 'user-1',
      username: 'testuser',
      isSystemAdmin: false,
      groups: [],
    },
    isAuthenticated: overrides.isAuthenticated ?? true,
    isLoading: overrides.isLoading ?? false,
    error: overrides.error ?? null,
  };
}

export function createMockAdminAuthState(overrides: Partial<MockAuthState> = {}): MockAuthState {
  return createMockAuthState({
    user: {
      userId: 'admin-1',
      username: 'admin',
      isSystemAdmin: true,
      groups: [],
    },
    ...overrides,
  });
}

// ============================================================================
// Validation Response Factories
// ============================================================================

export interface MockValidationResponse {
  valid: boolean;
  dependencies: Array<{
    service: string;
    satisfied: boolean;
    optional: boolean;
    providers: Array<{ serverId: string }>;
  }>;
  errors: string[];
  warnings: string[];
}

export function createMockValidationResponse(overrides: Partial<MockValidationResponse> = {}): MockValidationResponse {
  return {
    valid: overrides.valid ?? true,
    dependencies: overrides.dependencies || [],
    errors: overrides.errors || [],
    warnings: overrides.warnings || [],
  };
}

// ============================================================================
// Reset Counters (for test isolation)
// ============================================================================

export function resetFactoryCounters(): void {
  serverIdCounter = 1;
  deploymentIdCounter = 1;
  userIdCounter = 1;
}
