import { useAuthStore } from '../stores/useAuthStore';
import { showError } from '../lib/toast';
import type {
  ServerMetrics,
  NetworkInfo,
  AppSource,
  ConfigField,
  ServiceRequirement,
  ServiceDefinition,
  MountType,
  MountStatus,
  MountCredentials,
  DeploymentStatus,
} from '@ownprem/shared';

// Re-export imported types for convenience
export type {
  ServerMetrics,
  NetworkInfo,
  AppSource,
  ConfigField,
  ServiceRequirement,
  ServiceDefinition,
  MountType,
  MountStatus,
  MountCredentials,
  DeploymentStatus,
};

const API_BASE = '/api';

// Mutex to prevent concurrent token refresh attempts
let refreshPromise: Promise<boolean> | null = null;

// CSRF token cache
let csrfToken: string | null = null;
let csrfTokenPromise: Promise<string | null> | null = null;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Get headers for API requests.
 * No longer includes Authorization header - tokens are sent via httpOnly cookies.
 */
function getRequestHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
  };
}

/**
 * Fetch a CSRF token from the server.
 * Uses a promise mutex to prevent concurrent fetches.
 */
async function fetchCsrfToken(): Promise<string | null> {
  // If a fetch is already in progress, wait for it
  if (csrfTokenPromise) {
    return csrfTokenPromise;
  }

  const { isAuthenticated } = useAuthStore.getState();
  if (!isAuthenticated) {
    return null;
  }

  csrfTokenPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/csrf-token`, {
        headers: getRequestHeaders(),
        credentials: 'include', // Send httpOnly cookies
      });
      if (!res.ok) {
        console.warn('Failed to fetch CSRF token');
        return null;
      }
      const data = await res.json();
      csrfToken = data.csrfToken;
      return csrfToken;
    } catch {
      console.warn('Error fetching CSRF token');
      return null;
    } finally {
      csrfTokenPromise = null;
    }
  })();

  return csrfTokenPromise;
}

/**
 * Get the cached CSRF token, fetching a new one if needed.
 */
async function getCsrfToken(): Promise<string | null> {
  if (csrfToken) {
    return csrfToken;
  }
  return fetchCsrfToken();
}

/**
 * Clear the cached CSRF token (call on logout or auth failure).
 */
export function clearCsrfToken(): void {
  csrfToken = null;
}

async function handleResponse<T>(response: Response, retryFn?: () => Promise<Response>): Promise<T> {
  if (!response.ok) {
    // Handle 401 - try to refresh token and retry
    if (response.status === 401 && retryFn) {
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        // Token refreshed, retry the original request
        const retryResponse = await retryFn();
        return handleResponse<T>(retryResponse); // No retry function on retry to prevent infinite loops
      }
      // Refresh failed, logout
      useAuthStore.getState().logout();
    }

    // Handle 429 - rate limit exceeded
    if (response.status === 429) {
      showError('Too many requests. Please wait a moment and try again.', 'Rate Limit Exceeded');
    }

    const errorBody = await response.json().catch(() => ({ error: { message: 'Request failed' } }));
    const error = errorBody.error || {};

    // The server now sanitizes error messages, so we can display them directly
    // The requestId can be used for support correlation if needed
    throw new ApiError(
      response.status,
      error.code || 'UNKNOWN_ERROR',
      error.message || 'An unexpected error occurred',
      error.requestId
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

async function tryRefreshToken(): Promise<boolean> {
  // Check if authenticated before trying to refresh
  const { isAuthenticated } = useAuthStore.getState();
  if (!isAuthenticated) return false;

  // If a refresh is already in progress, wait for it instead of starting a new one
  // This prevents multiple concurrent refresh attempts creating multiple sessions
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const { logout } = useAuthStore.getState();

    try {
      // Refresh token is sent via httpOnly cookie automatically
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Send httpOnly cookies
      });

      if (!res.ok) {
        logout();
        return false;
      }

      // New tokens are set via Set-Cookie headers, no need to store them
      return true;
    } catch {
      logout();
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function fetchWithAuth<T>(url: string, options: RequestInit = {}): Promise<T> {
  // Get CSRF token for state-changing methods
  const method = options.method?.toUpperCase() || 'GET';
  const needsCsrf = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method);

  const headers: HeadersInit = {
    ...getRequestHeaders(),
    ...options.headers,
  };

  if (needsCsrf) {
    const token = await getCsrfToken();
    if (token) {
      (headers as Record<string, string>)['X-CSRF-Token'] = token;
    }
  }

  const doFetch = () => fetch(url, {
    ...options,
    headers,
    credentials: 'include', // Send httpOnly cookies for authentication
  });

  const response = await doFetch();
  return handleResponse<T>(response, doFetch);
}

export const api = {
  // Auth
  async login(username: string, password: string) {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // Receive httpOnly cookies
      body: JSON.stringify({ username, password }),
    });
    return handleResponse<LoginResponse>(res);
  },

  async loginWithTotp(username: string, password: string, totpCode: string) {
    const res = await fetch(`${API_BASE}/auth/login/totp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // Receive httpOnly cookies
      body: JSON.stringify({ username, password, totpCode }),
    });
    return handleResponse<AuthResponse>(res);
  },

  async logout() {
    // Logout call sends cookies automatically - server will clear them
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: getRequestHeaders(),
      credentials: 'include', // Send httpOnly cookies for server to clear
    }).catch(() => {}); // Ignore errors on logout
    clearCsrfToken();
    useAuthStore.getState().logout();
  },

  async getMe() {
    return fetchWithAuth<User>(`${API_BASE}/auth/me`);
  },

  async changePassword(oldPassword: string, newPassword: string) {
    return fetchWithAuth<{ message: string }>(`${API_BASE}/auth/change-password`, {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    });
  },

  async setup(username: string, password: string) {
    const res = await fetch(`${API_BASE}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    });
    return handleResponse<{ success: boolean; message: string }>(res);
  },

  // User management (admin only)
  async getUsers() {
    return fetchWithAuth<UserInfo[]>(`${API_BASE}/auth/users`);
  },

  async createUser(username: string, password: string, role: 'admin' | 'operator' | 'viewer' = 'viewer') {
    return fetchWithAuth<UserInfo>(`${API_BASE}/auth/users`, {
      method: 'POST',
      body: JSON.stringify({ username, password, role }),
    });
  },

  async deleteUser(userId: string) {
    return fetchWithAuth<void>(`${API_BASE}/auth/users/${userId}`, {
      method: 'DELETE',
    });
  },

  // Servers
  async getServers() {
    return fetchWithAuth<Server[]>(`${API_BASE}/servers`);
  },

  async getServer(id: string) {
    return fetchWithAuth<Server>(`${API_BASE}/servers/${id}`);
  },

  async addServer(data: { name: string; host: string }) {
    return fetchWithAuth<{ server: Server; bootstrapCommand: string }>(`${API_BASE}/servers`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async deleteServer(id: string) {
    return fetchWithAuth<void>(`${API_BASE}/servers/${id}`, { method: 'DELETE' });
  },

  async regenerateServerToken(id: string) {
    return fetchWithAuth<{ server: Server; bootstrapCommand: string }>(
      `${API_BASE}/servers/${id}/regenerate-token`,
      { method: 'POST' }
    );
  },

  // Apps
  async getApps(includeSystem = true) {
    const params = includeSystem ? '?includeSystem=true' : '';
    return fetchWithAuth<AppManifest[]>(`${API_BASE}/apps${params}`);
  },

  async getApp(name: string) {
    return fetchWithAuth<AppManifest>(`${API_BASE}/apps/${name}`);
  },

  // Deployments
  async getDeployments(serverId?: string) {
    const url = serverId ? `${API_BASE}/deployments?serverId=${serverId}` : `${API_BASE}/deployments`;
    return fetchWithAuth<Deployment[]>(url);
  },

  async getDeployment(id: string) {
    return fetchWithAuth<Deployment>(`${API_BASE}/deployments/${id}`);
  },

  async validateInstall(serverId: string, appName: string) {
    return fetchWithAuth<ValidationResult>(`${API_BASE}/deployments/validate`, {
      method: 'POST',
      body: JSON.stringify({ serverId, appName }),
    });
  },

  async installApp(
    serverId: string,
    appName: string,
    config?: Record<string, unknown>,
    groupId?: string,
    serviceBindings?: Record<string, string>
  ) {
    return fetchWithAuth<Deployment>(`${API_BASE}/deployments`, {
      method: 'POST',
      body: JSON.stringify({ serverId, appName, config, groupId, serviceBindings }),
    });
  },

  async updateDeployment(id: string, config: Record<string, unknown>) {
    return fetchWithAuth<Deployment>(`${API_BASE}/deployments/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    });
  },

  async startDeployment(id: string) {
    return fetchWithAuth<Deployment>(`${API_BASE}/deployments/${id}/start`, { method: 'POST' });
  },

  async stopDeployment(id: string) {
    return fetchWithAuth<Deployment>(`${API_BASE}/deployments/${id}/stop`, { method: 'POST' });
  },

  async restartDeployment(id: string) {
    return fetchWithAuth<Deployment>(`${API_BASE}/deployments/${id}/restart`, { method: 'POST' });
  },

  async uninstallDeployment(id: string) {
    return fetchWithAuth<void>(`${API_BASE}/deployments/${id}`, { method: 'DELETE' });
  },

  async getConnectionInfo(deploymentId: string) {
    return fetchWithAuth<ConnectionInfo>(`${API_BASE}/deployments/${deploymentId}/connection-info`);
  },

  async getDeploymentLogs(deploymentId: string, options?: { lines?: number; since?: string; grep?: string }) {
    const params = new URLSearchParams();
    if (options?.lines) params.set('lines', options.lines.toString());
    if (options?.since) params.set('since', options.since);
    if (options?.grep) params.set('grep', options.grep);
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchWithAuth<LogsResponse>(`${API_BASE}/deployments/${deploymentId}/logs${query}`);
  },

  // Services
  async getServices() {
    return fetchWithAuth<Service[]>(`${API_BASE}/services`);
  },

  // System
  async getSystemStatus() {
    return fetchWithAuth<SystemStatus>(`${API_BASE}/system/status`);
  },

  // Audit logs
  async getAuditLogs(options?: { limit?: number; offset?: number; action?: string }) {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    if (options?.action) params.set('action', options.action);
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchWithAuth<AuditLogsResponse>(`${API_BASE}/audit-logs${query}`);
  },

  async getAuditLogActions() {
    return fetchWithAuth<string[]>(`${API_BASE}/audit-logs/actions`);
  },

  // Sessions
  async getSessions() {
    return fetchWithAuth<SessionInfo[]>(`${API_BASE}/auth/sessions`);
  },

  async getSessionsWithCurrent() {
    // Refresh token is sent via httpOnly cookie automatically
    return fetchWithAuth<SessionInfo[]>(`${API_BASE}/auth/sessions/current`, {
      method: 'POST',
    });
  },

  async revokeSession(sessionId: string) {
    return fetchWithAuth<{ success: boolean }>(`${API_BASE}/auth/sessions/${sessionId}`, {
      method: 'DELETE',
    });
  },

  async revokeOtherSessions() {
    // Refresh token is sent via httpOnly cookie automatically
    return fetchWithAuth<{ success: boolean; revokedCount: number }>(`${API_BASE}/auth/sessions/revoke-others`, {
      method: 'POST',
    });
  },

  // TOTP
  async getTotpStatus() {
    return fetchWithAuth<TotpStatus>(`${API_BASE}/auth/totp/status`);
  },

  async setupTotp() {
    return fetchWithAuth<TotpSetupResponse>(`${API_BASE}/auth/totp/setup`, {
      method: 'POST',
    });
  },

  async verifyTotp(code: string) {
    return fetchWithAuth<{ success: boolean; message: string }>(`${API_BASE}/auth/totp/verify`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  },

  async disableTotp(password: string) {
    return fetchWithAuth<{ success: boolean; message: string }>(`${API_BASE}/auth/totp/disable`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },

  async regenerateBackupCodes() {
    return fetchWithAuth<{ backupCodes: string[] }>(`${API_BASE}/auth/totp/backup-codes`, {
      method: 'POST',
    });
  },

  // Admin: Reset user's 2FA
  async resetUserTotp(userId: string) {
    return fetchWithAuth<{ success: boolean; message: string }>(`${API_BASE}/auth/users/${userId}/totp/reset`, {
      method: 'POST',
    });
  },

  // Admin: Set system admin status
  async setSystemAdmin(userId: string, isSystemAdmin: boolean) {
    return fetchWithAuth<{ success: boolean }>(`${API_BASE}/auth/users/${userId}/system-admin`, {
      method: 'PUT',
      body: JSON.stringify({ isSystemAdmin }),
    });
  },

  // Groups
  async getGroups() {
    return fetchWithAuth<Group[]>(`${API_BASE}/auth/groups`);
  },

  async getGroup(groupId: string) {
    return fetchWithAuth<GroupWithMembers>(`${API_BASE}/auth/groups/${groupId}`);
  },

  async createGroup(name: string, description?: string, totpRequired?: boolean) {
    return fetchWithAuth<Group>(`${API_BASE}/auth/groups`, {
      method: 'POST',
      body: JSON.stringify({ name, description, totpRequired }),
    });
  },

  async updateGroup(groupId: string, updates: { name?: string; description?: string; totpRequired?: boolean }) {
    return fetchWithAuth<Group>(`${API_BASE}/auth/groups/${groupId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async deleteGroup(groupId: string) {
    return fetchWithAuth<void>(`${API_BASE}/auth/groups/${groupId}`, {
      method: 'DELETE',
    });
  },

  // Group membership
  async addUserToGroup(groupId: string, userId: string, role: 'admin' | 'operator' | 'viewer') {
    return fetchWithAuth<{ success: boolean }>(`${API_BASE}/auth/groups/${groupId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId, role }),
    });
  },

  async updateUserGroupRole(groupId: string, userId: string, role: 'admin' | 'operator' | 'viewer') {
    return fetchWithAuth<{ success: boolean }>(`${API_BASE}/auth/groups/${groupId}/members/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    });
  },

  async removeUserFromGroup(groupId: string, userId: string) {
    return fetchWithAuth<void>(`${API_BASE}/auth/groups/${groupId}/members/${userId}`, {
      method: 'DELETE',
    });
  },

  // Mounts
  async getMounts() {
    return fetchWithAuth<Mount[]>(`${API_BASE}/mounts`);
  },

  async getMount(id: string) {
    return fetchWithAuth<Mount>(`${API_BASE}/mounts/${id}`);
  },

  async createMount(data: CreateMountData) {
    return fetchWithAuth<Mount>(`${API_BASE}/mounts`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateMount(id: string, data: UpdateMountData) {
    return fetchWithAuth<Mount>(`${API_BASE}/mounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteMount(id: string) {
    return fetchWithAuth<void>(`${API_BASE}/mounts/${id}`, {
      method: 'DELETE',
    });
  },

  // Server Mounts
  async getServerMounts() {
    return fetchWithAuth<ServerMountWithDetails[]>(`${API_BASE}/mounts/servers`);
  },

  async assignMountToServer(data: AssignMountData) {
    return fetchWithAuth<ServerMountWithDetails>(`${API_BASE}/mounts/servers`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async mountStorage(serverMountId: string) {
    return fetchWithAuth<ServerMountWithDetails>(`${API_BASE}/mounts/servers/${serverMountId}/mount`, {
      method: 'POST',
    });
  },

  async unmountStorage(serverMountId: string) {
    return fetchWithAuth<ServerMountWithDetails>(`${API_BASE}/mounts/servers/${serverMountId}/unmount`, {
      method: 'POST',
    });
  },

  async deleteServerMount(serverMountId: string) {
    return fetchWithAuth<void>(`${API_BASE}/mounts/servers/${serverMountId}`, {
      method: 'DELETE',
    });
  },

  // Caddy HA
  async getHAConfig() {
    return fetchWithAuth<HAConfig | { enabled: false; configured: false }>(`${API_BASE}/caddy-ha/config`);
  },

  async configureHA(data: ConfigureHAData) {
    return fetchWithAuth<HAConfig>(`${API_BASE}/caddy-ha/config`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async setHAEnabled(enabled: boolean) {
    return fetchWithAuth<{ success: boolean; enabled: boolean }>(`${API_BASE}/caddy-ha/config/enabled`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
  },

  async getCaddyInstances() {
    return fetchWithAuth<CaddyInstance[]>(`${API_BASE}/caddy-ha/instances`);
  },

  async registerCaddyInstance(data: RegisterCaddyInstanceData) {
    return fetchWithAuth<CaddyInstance>(`${API_BASE}/caddy-ha/instances`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async setCaddyInstancePriority(instanceId: string, priority: number) {
    return fetchWithAuth<{ success: boolean; priority: number }>(`${API_BASE}/caddy-ha/instances/${instanceId}/priority`, {
      method: 'PUT',
      body: JSON.stringify({ priority }),
    });
  },

  async promoteCaddyInstance(instanceId: string) {
    return fetchWithAuth<{ success: boolean }>(`${API_BASE}/caddy-ha/instances/${instanceId}/promote`, {
      method: 'POST',
    });
  },

  async unregisterCaddyInstance(instanceId: string) {
    return fetchWithAuth<void>(`${API_BASE}/caddy-ha/instances/${instanceId}`, {
      method: 'DELETE',
    });
  },

  async syncKeepalived() {
    return fetchWithAuth<SyncResult>(`${API_BASE}/caddy-ha/sync/keepalived`, {
      method: 'POST',
    });
  },

  async syncCaddyConfig() {
    return fetchWithAuth<{ success: boolean; error?: string }>(`${API_BASE}/caddy-ha/sync/config`, {
      method: 'POST',
    });
  },

  // Certificates
  async getCertificates(options?: { type?: string; includeRevoked?: boolean }) {
    const params = new URLSearchParams();
    if (options?.type) params.set('type', options.type);
    if (options?.includeRevoked) params.set('includeRevoked', 'true');
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchWithAuth<CertificateInfo[]>(`${API_BASE}/certificates${query}`);
  },

  async getCertificate(id: string) {
    return fetchWithAuth<Certificate>(`${API_BASE}/certificates/${id}`);
  },

  async issueCertificate(data: IssueCertificateData) {
    return fetchWithAuth<Certificate>(`${API_BASE}/certificates`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async renewCertificate(certId: string, validityHours?: number) {
    return fetchWithAuth<Certificate>(`${API_BASE}/certificates/${certId}/renew`, {
      method: 'POST',
      body: JSON.stringify({ validityHours }),
    });
  },

  async revokeCertificate(certId: string, reason: string) {
    return fetchWithAuth<void>(`${API_BASE}/certificates/${certId}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  async getCertRenewalStatus() {
    return fetchWithAuth<CertRenewalStatus>(`${API_BASE}/certificates/renewal/status`);
  },

  async triggerCertRenewal() {
    return fetchWithAuth<CertRenewalResult>(`${API_BASE}/certificates/renewal/trigger`, {
      method: 'POST',
    });
  },

  async getSystemAppsStatus() {
    return fetchWithAuth<SystemAppsStatus>(`${API_BASE}/system/apps`);
  },

  // Proxy Routes
  async getProxyRoutes() {
    return fetchWithAuth<ProxyRoute[]>(`${API_BASE}/proxy-routes`);
  },
};

// Types
export interface UserGroupMembership {
  groupId: string;
  groupName: string;
  role: 'admin' | 'operator' | 'viewer';
  totpRequired: boolean;
}

export interface User {
  userId: string;
  username: string;
  isSystemAdmin: boolean;
  groups: UserGroupMembership[];
  totpEnabled?: boolean;
  totpRequired?: boolean;
}

export interface AuthResponse {
  // Tokens are now in httpOnly cookies - only user info returned in body
  expiresIn: number;
  user: User;
  totpSetupRequired?: boolean;
}

export interface UserInfo {
  id: string;
  username: string;
  is_system_admin: boolean;
  totp_enabled: boolean;
  created_at: string;
  last_login_at: string | null;
  groups: UserGroupMembership[];
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  totp_required: boolean;
  created_at: string;
  updated_at: string;
}

export interface GroupWithMembers extends Group {
  members: Array<{
    userId: string;
    username: string;
    role: 'admin' | 'operator' | 'viewer';
    isSystemAdmin: boolean;
  }>;
}

export interface Server {
  id: string;
  name: string;
  host: string | null;
  isCore: boolean;
  agentStatus: 'online' | 'offline' | 'error';
  metrics?: ServerMetrics;
  networkInfo?: NetworkInfo;
  lastSeen: string | null;
  createdAt: string;
}

// API response version of AppManifest (uses shared types for nested objects)
export interface AppManifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  category: string;
  source: AppSource;
  conflicts?: string[];
  webui?: { enabled: boolean; port: number; basePath: string };
  configSchema: ConfigField[];
  requires?: ServiceRequirement[];
  provides?: ServiceDefinition[];
  resources?: {
    minMemory?: string;
    minDisk?: string;
  };
  // System app properties
  system?: boolean;
  mandatory?: boolean;
  singleton?: boolean;
}

// API response version of Deployment (string dates, uses DeploymentStatus from shared)
export interface Deployment {
  id: string;
  serverId: string;
  appName: string;
  groupId?: string;
  version: string;
  config: Record<string, unknown>;
  status: string;
  statusMessage?: string;
  installedAt: string;
  updatedAt: string;
}

export interface Service {
  id: string;
  serviceName: string;
  serverId: string;
  host: string;
  port: number;
  status: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  dependencies: Array<{
    service: string;
    optional: boolean;
    locality: string;
    providers: Array<{ serverId: string; host: string; port: number }>;
    satisfied: boolean;
  }>;
}

export interface SystemStatus {
  status: string;
  servers: { total: number; online: number };
  deployments: { total: number; running: number };
  timestamp: string;
}

export interface AuditLogEntry {
  id: number;
  timestamp: string;
  userId: string | null;
  username: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  ipAddress: string | null;
  details: Record<string, unknown> | null;
}

export interface AuditLogsResponse {
  logs: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface SessionInfo {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  isCurrent: boolean;
}

export interface TotpStatus {
  enabled: boolean;
  backupCodesRemaining: number;
}

export interface TotpSetupResponse {
  secret: string;
  qrCode: string;
  backupCodes: string[];
}

export interface LoginResponse {
  // Tokens are now in httpOnly cookies - only user info returned in body
  user?: User;
  expiresIn?: number;
  totpRequired?: boolean;
  totpSetupRequired?: boolean;
  message?: string;
}

export interface ServiceConnectionInfo {
  serviceName: string;
  protocol: string;
  // Proxied connection (through Caddy - recommended)
  host: string;
  port?: number;
  path?: string;
  // Direct connection (internal only)
  directHost: string;
  directPort: number;
  // Tor connection
  torAddress?: string;
  credentials?: Record<string, string>;
}

export interface ConnectionInfo {
  appName: string;
  displayName: string;
  serverId: string;
  status: string;
  services: ServiceConnectionInfo[];
}

export interface LogsResponse {
  appName: string;
  serverId: string;
  logs: string[];
  source: 'journalctl' | 'file';
  hasMore: boolean;
  status: 'success' | 'error';
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

// API response versions of Mount types (string dates instead of Date)
export interface Mount {
  id: string;
  name: string;
  mountType: MountType;
  source: string;
  defaultOptions: string | null;
  hasCredentials: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServerMount {
  id: string;
  serverId: string;
  mountId: string;
  mountPoint: string;
  options: string | null;
  purpose: string | null;
  autoMount: boolean;
  status: MountStatus;
  statusMessage: string | null;
  lastChecked: string | null;
  usageBytes: number | null;
  totalBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServerMountWithDetails extends ServerMount {
  mount: Mount;
  serverName: string;
}

export interface CreateMountData {
  name: string;
  mountType: MountType;
  source: string;
  defaultOptions?: string;
  description?: string;
  credentials?: MountCredentials;
}

export interface UpdateMountData {
  name?: string;
  source?: string;
  defaultOptions?: string | null;
  description?: string | null;
  credentials?: MountCredentials | null;
}

export interface AssignMountData {
  serverId: string;
  mountId: string;
  mountPoint: string;
  options?: string;
  purpose?: string;
  autoMount?: boolean;
}

/**
 * Helper to normalize responses that may or may not be paginated.
 * Returns the data array whether the response is paginated or not.
 */
export function extractData<T>(response: T[] | PaginatedResponse<T>): T[] {
  if (Array.isArray(response)) {
    return response;
  }
  return response.data;
}

// Caddy HA types
export interface HAConfig {
  id: string;
  vipAddress: string;
  vipInterface: string;
  vrrpRouterId: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigureHAData {
  vipAddress: string;
  vipInterface?: string;
  vrrpRouterId?: number;
  vrrpAuthPass?: string;
}

export interface CaddyInstance {
  id: string;
  deploymentId: string;
  haConfigId: string | null;
  vrrpPriority: number;
  isPrimary: boolean;
  adminApiUrl: string | null;
  lastConfigSync: string | null;
  lastCertSync: string | null;
  status: 'pending' | 'active' | 'error';
  statusMessage: string | null;
  serverId: string;
  serverName: string;
  serverHost: string | null;
  deploymentStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterCaddyInstanceData {
  deploymentId: string;
  vrrpPriority?: number;
  isPrimary?: boolean;
  adminApiUrl?: string;
}

export interface SyncResult {
  success: boolean;
  results: Array<{
    instanceId: string;
    success: boolean;
    error?: string;
  }>;
}

// Certificate types
export interface CertificateInfo {
  id: string;
  name: string;
  type: 'server' | 'client' | 'ca';
  subjectCn: string;
  subjectSans: string[] | null;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  issuedToServerId: string | null;
  issuedToDeploymentId: string | null;
  revokedAt: string | null;
  createdAt: string;
  expiresInDays: number;
}

export interface Certificate extends CertificateInfo {
  certPem: string;
  keyPem: string;
  caCertPem: string;
}

export interface IssueCertificateData {
  name: string;
  type: 'server' | 'client';
  commonName: string;
  sans?: string[];
  validityHours?: number;
  issuedToServerId?: string;
  issuedToDeploymentId?: string;
}

export interface CertRenewalStatus {
  nextCheckAt: string | null;
  thresholdDays: number;
  expiringCount: number;
  expiringSoon: Array<{
    id: string;
    name: string;
    cn: string;
    expiresAt: string;
    daysUntilExpiry: number;
  }>;
}

export interface CertRenewalResult {
  checked: number;
  renewed: number;
  failed: number;
  details: Array<{
    certId: string;
    name: string;
    success: boolean;
    error?: string;
  }>;
}

export interface SystemAppsStatus {
  apps: Array<{
    name: string;
    displayName: string;
    installed: boolean;
    status?: string;
  }>;
  allInstalled: boolean;
}

export interface ProxyRoute {
  path: string;
  upstream: string;
  appName: string;
  serverName: string;
  active: boolean;
}
