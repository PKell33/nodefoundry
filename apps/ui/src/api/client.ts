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

async function handleResponse<T>(response: Response, retryFn?: () => Promise<Response>, csrfRetried = false): Promise<T> {
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

    // Handle 403 with CSRF error - clear token and retry once
    if (response.status === 403 && retryFn && !csrfRetried) {
      const errorBody = await response.clone().json().catch(() => ({ error: {} }));
      if (errorBody.error?.message?.toLowerCase().includes('csrf')) {
        clearCsrfToken();
        // Fetch new CSRF token and retry
        await fetchCsrfToken();
        const retryResponse = await retryFn();
        return handleResponse<T>(retryResponse, undefined, true);
      }
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

  const doFetch = async () => {
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

    return fetch(url, {
      ...options,
      headers,
      credentials: 'include', // Send httpOnly cookies for authentication
    });
  };

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

  async checkSetup() {
    const res = await fetch(`${API_BASE}/auth/setup`, {
      credentials: 'include',
    });
    return handleResponse<{ needsSetup: boolean }>(res);
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

  // Apps (Umbrel App Store)
  async getApps(category?: string) {
    const query = category ? `?category=${encodeURIComponent(category)}` : '';
    return fetchWithAuth<AppsResponse>(`${API_BASE}/apps${query}`);
  },

  async getApp(id: string) {
    return fetchWithAuth<UmbrelApp>(`${API_BASE}/apps/${encodeURIComponent(id)}`);
  },

  async getAppCategories() {
    return fetchWithAuth<AppCategoriesResponse>(`${API_BASE}/apps/categories`);
  },

  async syncApps(registryId?: string) {
    const query = registryId ? `?registry=${encodeURIComponent(registryId)}` : '';
    return fetchWithAuth<AppSyncResponse>(`${API_BASE}/apps/sync${query}`, {
      method: 'POST',
    });
  },

  async getAppSyncStatus() {
    return fetchWithAuth<AppSyncStatus>(`${API_BASE}/apps/status`);
  },

  // Umbrel Registries
  async getUmbrelRegistries() {
    return fetchWithAuth<UmbrelRegistriesResponse>(`${API_BASE}/apps/registries`);
  },

  async addUmbrelRegistry(id: string, name: string, url: string) {
    return fetchWithAuth<UmbrelRegistry>(`${API_BASE}/apps/registries`, {
      method: 'POST',
      body: JSON.stringify({ id, name, url }),
    });
  },

  async updateUmbrelRegistry(id: string, updates: { name?: string; url?: string; enabled?: boolean }) {
    return fetchWithAuth<UmbrelRegistry>(`${API_BASE}/apps/registries/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async removeUmbrelRegistry(id: string) {
    return fetchWithAuth<void>(`${API_BASE}/apps/registries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  // Umbrel app icon URL helper (registry-specific)
  getUmbrelIconUrl(appId: string, registry?: string) {
    if (registry) {
      return `${API_BASE}/apps/${encodeURIComponent(registry)}/${encodeURIComponent(appId)}/icon`;
    }
    return `${API_BASE}/apps/${encodeURIComponent(appId)}/icon`;
  },

  // Start9 Apps
  async getStart9Apps() {
    return fetchWithAuth<Start9AppsResponse>(`${API_BASE}/start9/apps`);
  },

  async getStart9App(id: string) {
    return fetchWithAuth<Start9App>(`${API_BASE}/start9/apps/${encodeURIComponent(id)}`);
  },

  async syncStart9Apps(registryId?: string) {
    const query = registryId ? `?registry=${encodeURIComponent(registryId)}` : '';
    return fetchWithAuth<Start9SyncResponse>(`${API_BASE}/start9/apps/sync${query}`, {
      method: 'POST',
    });
  },

  async getStart9SyncStatus() {
    return fetchWithAuth<Start9SyncStatus>(`${API_BASE}/start9/apps/status`);
  },

  async loadStart9Image(appId: string) {
    return fetchWithAuth<Start9LoadImageResponse>(`${API_BASE}/start9/apps/${encodeURIComponent(appId)}/load-image`, {
      method: 'POST',
    });
  },

  // Start9 app icon URL helper (not an API call, just constructs the URL)
  getStart9IconUrl(appId: string) {
    return `${API_BASE}/start9/apps/${encodeURIComponent(appId)}/icon`;
  },

  // Start9 Registries
  async getStart9Registries() {
    return fetchWithAuth<Start9RegistriesResponse>(`${API_BASE}/start9/registries`);
  },

  async addStart9Registry(id: string, name: string, url: string) {
    return fetchWithAuth<Start9Registry>(`${API_BASE}/start9/registries`, {
      method: 'POST',
      body: JSON.stringify({ id, name, url }),
    });
  },

  async updateStart9Registry(id: string, updates: { name?: string; url?: string; enabled?: boolean }) {
    return fetchWithAuth<Start9Registry>(`${API_BASE}/start9/registries/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async removeStart9Registry(id: string) {
    return fetchWithAuth<void>(`${API_BASE}/start9/registries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  // CasaOS Apps
  async getCasaOSApps() {
    return fetchWithAuth<CasaOSAppsResponse>(`${API_BASE}/casaos/apps`);
  },

  async getCasaOSApp(id: string) {
    return fetchWithAuth<CasaOSApp>(`${API_BASE}/casaos/apps/${encodeURIComponent(id)}`);
  },

  async syncCasaOSApps(registryId?: string) {
    const query = registryId ? `?registry=${encodeURIComponent(registryId)}` : '';
    return fetchWithAuth<CasaOSSyncResponse>(`${API_BASE}/casaos/apps/sync${query}`, {
      method: 'POST',
    });
  },

  async getCasaOSSyncStatus() {
    return fetchWithAuth<CasaOSSyncStatus>(`${API_BASE}/casaos/apps/status`);
  },

  // CasaOS Registries
  async getCasaOSRegistries() {
    return fetchWithAuth<CasaOSRegistriesResponse>(`${API_BASE}/casaos/registries`);
  },

  async addCasaOSRegistry(id: string, name: string, url: string) {
    return fetchWithAuth<CasaOSRegistry>(`${API_BASE}/casaos/registries`, {
      method: 'POST',
      body: JSON.stringify({ id, name, url }),
    });
  },

  async updateCasaOSRegistry(id: string, updates: { name?: string; url?: string; enabled?: boolean }) {
    return fetchWithAuth<CasaOSRegistry>(`${API_BASE}/casaos/registries/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async removeCasaOSRegistry(id: string) {
    return fetchWithAuth<void>(`${API_BASE}/casaos/registries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  // Runtipi Apps
  async getRuntipiApps() {
    return fetchWithAuth<RuntipiAppsResponse>(`${API_BASE}/runtipi/apps`);
  },

  async getRuntipiApp(id: string) {
    return fetchWithAuth<RuntipiApp>(`${API_BASE}/runtipi/apps/${encodeURIComponent(id)}`);
  },

  async syncRuntipiApps(registryId?: string) {
    const query = registryId ? `?registry=${encodeURIComponent(registryId)}` : '';
    return fetchWithAuth<RuntipiSyncResponse>(`${API_BASE}/runtipi/apps/sync${query}`, {
      method: 'POST',
    });
  },

  async getRuntipiSyncStatus() {
    return fetchWithAuth<RuntipiSyncStatus>(`${API_BASE}/runtipi/apps/status`);
  },

  // Runtipi Registries
  async getRuntipiRegistries() {
    return fetchWithAuth<RuntipiRegistriesResponse>(`${API_BASE}/runtipi/registries`);
  },

  async addRuntipiRegistry(id: string, name: string, url: string) {
    return fetchWithAuth<RuntipiRegistry>(`${API_BASE}/runtipi/registries`, {
      method: 'POST',
      body: JSON.stringify({ id, name, url }),
    });
  },

  async updateRuntipiRegistry(id: string, updates: { name?: string; url?: string; enabled?: boolean }) {
    return fetchWithAuth<RuntipiRegistry>(`${API_BASE}/runtipi/registries/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async removeRuntipiRegistry(id: string) {
    return fetchWithAuth<void>(`${API_BASE}/runtipi/registries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  // Deployments
  async getDeployments(serverId?: string) {
    const query = serverId ? `?serverId=${encodeURIComponent(serverId)}` : '';
    return fetchWithAuth<DeploymentsResponse>(`${API_BASE}/deployments${query}`);
  },

  async getDeployment(id: string) {
    return fetchWithAuth<DeploymentInfo>(`${API_BASE}/deployments/${encodeURIComponent(id)}`);
  },

  async deployApp(serverId: string, appId: string, config?: Record<string, unknown>) {
    return fetchWithAuth<DeploymentInfo>(`${API_BASE}/deployments`, {
      method: 'POST',
      body: JSON.stringify({ serverId, appId, config }),
    });
  },

  async startDeployment(id: string) {
    return fetchWithAuth<DeploymentInfo>(`${API_BASE}/deployments/${encodeURIComponent(id)}/start`, {
      method: 'POST',
    });
  },

  async stopDeployment(id: string) {
    return fetchWithAuth<DeploymentInfo>(`${API_BASE}/deployments/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    });
  },

  async restartDeployment(id: string) {
    return fetchWithAuth<DeploymentInfo>(`${API_BASE}/deployments/${encodeURIComponent(id)}/restart`, {
      method: 'POST',
    });
  },

  async uninstallDeployment(id: string) {
    return fetchWithAuth<void>(`${API_BASE}/deployments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async getDeploymentLogs(id: string, lines?: number) {
    const query = lines ? `?lines=${lines}` : '';
    return fetchWithAuth<DeploymentLogsResponse>(`${API_BASE}/deployments/${encodeURIComponent(id)}/logs${query}`);
  },

  // System
  async getSystemStatus() {
    return fetchWithAuth<SystemStatus>(`${API_BASE}/system/status`);
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

// App store source type
export type AppStoreSource = 'umbrel' | 'start9' | 'casaos' | 'runtipi';

// Umbrel Registry types
export interface UmbrelRegistry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  appCount?: number;
  lastSync?: string;
  createdAt: string;
}

export interface UmbrelRegistriesResponse {
  registries: UmbrelRegistry[];
}

// Umbrel App Store types
export interface UmbrelApp {
  id: string;
  name: string;
  version: string;
  tagline: string;
  description: string;
  category: string;
  developer: string;
  website: string;
  repo: string;
  port: number;
  dependencies: string[];
  icon: string;
  gallery: string[];
  composeFile: string;
  manifest: UmbrelAppManifest;
  source?: AppStoreSource; // Which store this app came from
}

export interface UmbrelAppManifest {
  manifestVersion: number;
  id: string;
  category: string;
  name: string;
  version: string;
  tagline: string;
  description: string;
  developer: string;
  website: string;
  dependencies: string[];
  repo: string;
  support: string;
  port: number;
  gallery: string[];
  path: string;
  defaultUsername?: string;
  defaultPassword?: string;
  releaseNotes?: string;
  submitter?: string;
  submission?: string;
}

export interface AppsResponse {
  apps: UmbrelApp[];
  count: number;
}

export interface AppSyncResponse {
  synced: number;
  updated: number;
  removed: number;
  errors: string[];
  message: string;
}

export interface AppSyncStatus {
  needsSync: boolean;
  appCount: number;
}

export interface AppCategory {
  category: string;
  count: number;
}

export interface AppCategoriesResponse {
  categories: AppCategory[];
}

// Start9 App Store types
export interface Start9AppInterface {
  name: string;
  description: string;
  protocols: string[];
  ui: boolean;
}

export interface Start9App {
  id: string;
  name: string;
  version: string;
  gitHash: string;
  shortDescription: string;
  longDescription: string;
  releaseNotes?: string;
  license: string;
  wrapperRepo: string;
  upstreamRepo: string;
  supportSite: string;
  marketingSite: string;
  donationUrl?: string;
  icon: string;
  categories: string[];
  interfaces: Start9AppInterface[];
  dependencies: string[];
  registry: string; // Registry ID (e.g., 'official', 'community', 'bip110')
  publishedAt: string;
  versions: string[];
}

export interface Start9Registry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  appCount?: number;
  lastSync?: string;
  createdAt: string;
}

export interface Start9RegistriesResponse {
  registries: Start9Registry[];
}

export interface Start9AppsResponse {
  apps: Start9App[];
  count: number;
}

export interface Start9SyncResponse {
  synced: number;
  updated: number;
  removed: number;
  errors: string[];
  message: string;
}

export interface Start9SyncStatus {
  needsSync: boolean;
  appCount: number;
  source: 'start9';
}

export interface Start9LoadImageResponse {
  success: boolean;
  appId: string;
  imageId: string;
  message: string;
}

// CasaOS App Store types
export interface CasaOSApp {
  id: string;
  name: string;
  version: string;
  tagline: string;
  description: string;
  developer: string;
  author: string;
  icon: string;
  screenshot?: string;
  category: string;
  architectures: string[];
  port: number;
  registry: string;
  image: string;
  composeFile: string;
}

export interface CasaOSRegistry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  appCount?: number;
  lastSync?: string;
  createdAt: string;
}

export interface CasaOSRegistriesResponse {
  registries: CasaOSRegistry[];
}

export interface CasaOSAppsResponse {
  apps: CasaOSApp[];
  count: number;
}

export interface CasaOSSyncResponse {
  synced: number;
  updated: number;
  removed: number;
  errors: string[];
  message: string;
}

export interface CasaOSSyncStatus {
  appCount: number;
  source: 'casaos';
}

// Runtipi App Store types
export interface RuntipiApp {
  id: string;
  name: string;
  version: string;
  tipiVersion: number;
  shortDesc: string;
  description: string;
  author: string;
  source: string;
  icon: string;
  categories: string[];
  architectures: string[];
  port: number;
  registry: string;
  exposable: boolean;
  available: boolean;
  composeFile: string;
}

export interface RuntipiRegistry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  appCount?: number;
  lastSync?: string;
  createdAt: string;
}

export interface RuntipiRegistriesResponse {
  registries: RuntipiRegistry[];
}

export interface RuntipiAppsResponse {
  apps: RuntipiApp[];
  count: number;
}

export interface RuntipiSyncResponse {
  synced: number;
  updated: number;
  removed: number;
  errors: string[];
  message: string;
}

export interface RuntipiSyncStatus {
  appCount: number;
  source: 'runtipi';
}

// Deployment types
export interface DeploymentInfo {
  id: string;
  serverId: string;
  appId: string;
  appName: string;
  version: string;
  status: 'pending' | 'installing' | 'running' | 'stopped' | 'error';
  statusMessage?: string;
  installedAt: string;
  updatedAt: string;
}

export interface DeploymentsResponse {
  deployments: DeploymentInfo[];
  count: number;
}

export interface DeploymentLogsResponse {
  logs: string;
  lines: number;
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
