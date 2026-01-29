import { useAuthStore } from '../stores/useAuthStore';

const API_BASE = '/api';

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

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    // Handle 401 - try to refresh token
    if (response.status === 401) {
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        // Token refreshed, but caller should retry the request
        throw new ApiError(401, 'TOKEN_REFRESHED', 'Token refreshed, please retry');
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
  const { refreshToken, setTokens, logout } = useAuthStore.getState();
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
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
  }
}

async function fetchWithAuth<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...options.headers,
    },
  });
  return handleResponse<T>(response);
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

  async installApp(serverId: string, appName: string, config?: Record<string, unknown>, groupId?: string) {
    return fetchWithAuth<Deployment>(`${API_BASE}/deployments`, {
      method: 'POST',
      body: JSON.stringify({ serverId, appName, config, groupId }),
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
  isFoundry: boolean;
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
