import { useAuthStore } from '../stores/useAuthStore';

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
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function getAuthHeaders(): HeadersInit {
  const { accessToken } = useAuthStore.getState();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  return headers;
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

  const { accessToken } = useAuthStore.getState();
  if (!accessToken) {
    return null;
  }

  csrfTokenPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/csrf-token`, {
        headers: getAuthHeaders(),
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

    const error = await response.json().catch(() => ({ error: { message: 'Request failed' } }));
    throw new ApiError(
      response.status,
      error.error?.code || 'UNKNOWN_ERROR',
      error.error?.message || 'Request failed'
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

async function tryRefreshToken(): Promise<boolean> {
  // Check for refresh token before acquiring mutex
  const { refreshToken } = useAuthStore.getState();
  if (!refreshToken) return false;

  // If a refresh is already in progress, wait for it instead of starting a new one
  // This prevents multiple concurrent refresh attempts creating multiple sessions
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const { refreshToken: token, setTokens, logout } = useAuthStore.getState();
    if (!token) return false;

    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });

      if (!res.ok) {
        logout();
        return false;
      }

      const data = await res.json();
      setTokens(data.accessToken, data.refreshToken);
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
    ...getAuthHeaders(),
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
      body: JSON.stringify({ username, password }),
    });
    return handleResponse<LoginResponse>(res);
  },

  async loginWithTotp(username: string, password: string, totpCode: string) {
    const res = await fetch(`${API_BASE}/auth/login/totp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, totpCode }),
    });
    return handleResponse<AuthResponse>(res);
  },

  async logout() {
    const { refreshToken } = useAuthStore.getState();
    if (refreshToken) {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ refreshToken }),
      }).catch(() => {}); // Ignore errors on logout
    }
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
      body: JSON.stringify({ username, password }),
    });
    return handleResponse<AuthResponse>(res);
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
  async getApps() {
    return fetchWithAuth<AppManifest[]>(`${API_BASE}/apps`);
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

  async getSessionsWithCurrent(refreshToken: string) {
    return fetchWithAuth<SessionInfo[]>(`${API_BASE}/auth/sessions/current`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
  },

  async revokeSession(sessionId: string) {
    return fetchWithAuth<{ success: boolean }>(`${API_BASE}/auth/sessions/${sessionId}`, {
      method: 'DELETE',
    });
  },

  async revokeOtherSessions(refreshToken: string) {
    return fetchWithAuth<{ success: boolean; revokedCount: number }>(`${API_BASE}/auth/sessions/revoke-others`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
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
  accessToken: string;
  refreshToken: string;
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
  lastSeen: string | null;
  createdAt: string;
}

export interface ServerMetrics {
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number;
  diskTotal: number;
  loadAverage: [number, number, number];
}

export interface AppSource {
  type: 'binary' | 'git' | 'apt';
  githubRepo?: string;
  downloadUrl?: string;
  checksumUrl?: string;
  gitUrl?: string;
  tagPrefix?: string;
}

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
}

export interface ConfigField {
  name: string;
  type: string;
  label: string;
  description?: string;
  default?: unknown;
  options?: string[];
  required?: boolean;
  generated?: boolean;
  secret?: boolean;
  inheritFrom?: string;
}

export interface ServiceRequirement {
  service: string;
  optional?: boolean;
  locality: string;
}

export interface ServiceDefinition {
  name: string;
  port: number;
  protocol: string;
}

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

export interface LoginResponse extends AuthResponse {
  totpRequired?: boolean;
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
