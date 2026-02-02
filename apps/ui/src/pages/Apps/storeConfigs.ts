import { api, type UmbrelApp, type Start9App, type CasaOSApp, type RuntipiApp } from '../../api/client';
import type { NormalizedApp, AppStoreSource, SyncResult, Registry } from '../../components/AppStore';

/**
 * Generic app type that all store apps must conform to for filtering
 */
export interface BaseApp {
  id: string;
  name: string;
  registry?: string;
}

/**
 * Response type for apps list
 */
interface AppsResponse<T> {
  apps: T[];
  count?: number;
}

/**
 * Response type for registries list
 */
interface RegistriesResponse {
  registries: Registry[];
}

/**
 * Store configuration defining API methods and normalization
 */
export interface StoreConfig<TApp extends BaseApp> {
  storeType: AppStoreSource;
  queryKeys: {
    registries: string;
    apps: string;
  };
  api: {
    getRegistries: () => Promise<RegistriesResponse>;
    getApps: () => Promise<AppsResponse<TApp>>;
    syncApps: (registryId: string) => Promise<SyncResult>;
    addRegistry: (id: string, name: string, url: string) => Promise<unknown>;
    updateRegistry: (id: string, updates: { enabled: boolean }) => Promise<unknown>;
    removeRegistry: (id: string) => Promise<void>;
  };
  normalizeApp: (app: TApp) => NormalizedApp;
  filterApp: (app: TApp, searchQuery: string) => boolean;
  getCategories: (app: TApp) => string[];
  matchCategory: (app: TApp, category: string) => boolean;
  urlPlaceholder?: string;
}

// Umbrel store configuration
export const umbrelConfig: StoreConfig<UmbrelApp & { registry?: string }> = {
  storeType: 'umbrel',
  queryKeys: {
    registries: 'umbrelRegistries',
    apps: 'apps',
  },
  api: {
    getRegistries: () => api.getUmbrelRegistries(),
    getApps: () => api.getApps(),
    syncApps: (registryId) => api.syncApps(registryId),
    addRegistry: (id, name, url) => api.addUmbrelRegistry(id, name, url),
    updateRegistry: (id, updates) => api.updateUmbrelRegistry(id, updates),
    removeRegistry: (id) => api.removeUmbrelRegistry(id),
  },
  normalizeApp: (app) => ({
    id: app.id,
    name: app.name,
    version: app.version,
    tagline: app.tagline || '',
    description: app.description || '',
    category: app.category?.toLowerCase() || 'utilities',
    categories: [app.category],
    developer: app.developer || 'Unknown',
    icon: app.icon || '',
    port: app.port,
    registry: app.registry,
    source: 'umbrel',
    original: app,
  }),
  filterApp: (app, query) =>
    app.name.toLowerCase().includes(query) ||
    app.tagline?.toLowerCase().includes(query) ||
    app.description?.toLowerCase().includes(query),
  getCategories: (app) => [app.category || 'Uncategorized'],
  matchCategory: (app, category) =>
    app.category?.toLowerCase() === category.toLowerCase(),
  urlPlaceholder: 'GitHub URL (e.g., https://github.com/getumbrel/umbrel-apps)',
};

// Start9 store configuration
export const start9Config: StoreConfig<Start9App> = {
  storeType: 'start9',
  queryKeys: {
    registries: 'start9Registries',
    apps: 'start9Apps',
  },
  api: {
    getRegistries: () => api.getStart9Registries(),
    getApps: () => api.getStart9Apps(),
    syncApps: (registryId) => api.syncStart9Apps(registryId),
    addRegistry: (id, name, url) => api.addStart9Registry(id, name, url),
    updateRegistry: (id, updates) => api.updateStart9Registry(id, updates),
    removeRegistry: (id) => api.removeStart9Registry(id),
  },
  normalizeApp: (app) => ({
    id: app.id,
    name: app.name,
    version: app.version,
    tagline: app.shortDescription || '',
    description: app.longDescription || '',
    category: app.categories?.[0]?.toLowerCase() || 'bitcoin',
    categories: app.categories,
    developer: app.wrapperRepo?.split('/')[3] || 'Unknown',
    icon: app.icon || api.getStart9IconUrl(app.id),
    port: 0,
    registry: app.registry,
    source: 'start9',
    original: app,
  }),
  filterApp: (app, query) =>
    app.name.toLowerCase().includes(query) ||
    app.shortDescription?.toLowerCase().includes(query) ||
    app.longDescription?.toLowerCase().includes(query),
  getCategories: (app) => app.categories || ['Uncategorized'],
  matchCategory: (app, category) => app.categories?.includes(category) ?? false,
  urlPlaceholder: 'Registry URL (e.g., https://registry.start9.com/)',
};

// CasaOS store configuration
export const casaosConfig: StoreConfig<CasaOSApp> = {
  storeType: 'casaos',
  queryKeys: {
    registries: 'casaosRegistries',
    apps: 'casaosApps',
  },
  api: {
    getRegistries: () => api.getCasaOSRegistries(),
    getApps: () => api.getCasaOSApps(),
    syncApps: (registryId) => api.syncCasaOSApps(registryId),
    addRegistry: (id, name, url) => api.addCasaOSRegistry(id, name, url),
    updateRegistry: (id, updates) => api.updateCasaOSRegistry(id, updates),
    removeRegistry: (id) => api.removeCasaOSRegistry(id),
  },
  normalizeApp: (app) => ({
    id: app.id,
    name: app.name,
    version: app.version,
    tagline: app.tagline || '',
    description: app.description || '',
    category: app.category?.toLowerCase() || 'utilities',
    categories: [app.category],
    developer: app.developer || app.author || 'Unknown',
    icon: app.icon || '',
    port: app.port,
    registry: app.registry,
    source: 'casaos',
    original: app,
  }),
  filterApp: (app, query) =>
    app.name.toLowerCase().includes(query) ||
    app.tagline?.toLowerCase().includes(query) ||
    app.description?.toLowerCase().includes(query),
  getCategories: (app) => [app.category || 'Uncategorized'],
  matchCategory: (app, category) => app.category === category,
};

// Runtipi store configuration
export const runtipiConfig: StoreConfig<RuntipiApp> = {
  storeType: 'runtipi',
  queryKeys: {
    registries: 'runtipiRegistries',
    apps: 'runtipiApps',
  },
  api: {
    getRegistries: () => api.getRuntipiRegistries(),
    getApps: () => api.getRuntipiApps(),
    syncApps: (registryId) => api.syncRuntipiApps(registryId),
    addRegistry: (id, name, url) => api.addRuntipiRegistry(id, name, url),
    updateRegistry: (id, updates) => api.updateRuntipiRegistry(id, updates),
    removeRegistry: (id) => api.removeRuntipiRegistry(id),
  },
  normalizeApp: (app) => ({
    id: app.id,
    name: app.name,
    version: app.version,
    tagline: app.shortDesc || '',
    description: app.description || '',
    category: app.categories[0]?.toLowerCase() || 'utilities',
    categories: app.categories,
    developer: app.author || 'Unknown',
    icon: app.icon || '',
    port: app.port,
    registry: app.registry,
    source: 'runtipi',
    original: app,
  }),
  filterApp: (app, query) =>
    app.name.toLowerCase().includes(query) ||
    app.shortDesc?.toLowerCase().includes(query) ||
    app.description?.toLowerCase().includes(query),
  getCategories: (app) => app.categories || ['Uncategorized'],
  matchCategory: (app, category) => app.categories?.includes(category) ?? false,
};
