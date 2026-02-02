import { Outlet, useParams, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Breadcrumb, type BreadcrumbItem } from '../../components/Breadcrumb';
import type { AppStoreSource } from '../../components/AppStore/types';

// Store display names
const STORE_NAMES: Record<string, string> = {
  umbrel: 'Umbrel',
  start9: 'Start9',
  casaos: 'CasaOS',
  runtipi: 'Runtipi',
};

// Valid store types
const VALID_STORES = ['umbrel', 'start9', 'casaos', 'runtipi'];

/**
 * Layout wrapper for all app store pages.
 * Provides consistent breadcrumb navigation at the top.
 */
export default function AppsLayout() {
  const params = useParams<{
    store?: string;
    registry?: string;
    appId?: string;
  }>();
  const location = useLocation();

  // Parse path segments to determine current location
  // Path format: /apps, /apps/store, /apps/store/registry, /apps/store/registry/appId
  const pathSegments = location.pathname.split('/').filter(Boolean);
  // pathSegments[0] = 'apps', [1] = store, [2] = registry, [3] = appId

  const store = pathSegments[1] && VALID_STORES.includes(pathSegments[1]) ? pathSegments[1] : params.store;
  const registry = pathSegments[2] || params.registry;
  const appId = pathSegments[3] || params.appId;

  const storeType = store as AppStoreSource | undefined;

  // Fetch registries to get registry name
  const { data: registriesData } = useQuery({
    queryKey: ['registries', store],
    queryFn: async () => {
      switch (storeType) {
        case 'umbrel':
          return api.getUmbrelRegistries();
        case 'start9':
          return api.getStart9Registries();
        case 'casaos':
          return api.getCasaOSRegistries();
        case 'runtipi':
          return api.getRuntipiRegistries();
        default:
          return { registries: [] };
      }
    },
    enabled: !!store,
  });

  // Fetch app to get app name
  const { data: app } = useQuery({
    queryKey: ['app', store, appId],
    queryFn: async () => {
      switch (storeType) {
        case 'umbrel':
          return api.getApp(appId!);
        case 'start9':
          return api.getStart9App(appId!);
        case 'casaos':
          return api.getCasaOSApp(appId!);
        case 'runtipi':
          return api.getRuntipiApp(appId!);
        default:
          return null;
      }
    },
    enabled: !!store && !!appId,
  });

  // Get registry display name
  const registries = registriesData?.registries || [];
  const registryInfo = registries.find((r) => r.id === registry);
  const registryName = registryInfo?.name || registry || '';

  // Get app display name
  const getAppName = (): string => {
    if (!app) return appId || '';
    const appObj = app as unknown as Record<string, unknown>;
    return (appObj.name as string) || (appObj.title as string) || appId || '';
  };

  // Build breadcrumb items based on current route
  const buildBreadcrumbItems = (): BreadcrumbItem[] => {
    const items: BreadcrumbItem[] = [];
    const isRoot = location.pathname === '/apps';

    // Apps is always the first item
    if (isRoot) {
      items.push({ label: 'Apps' });
    } else {
      items.push({ label: 'Apps', href: '/apps' });
    }

    // Add store level
    if (store) {
      const storeName = STORE_NAMES[store] || store;
      if (!registry) {
        // At store level, store is not a link
        items.push({ label: storeName });
      } else {
        // Deeper than store level, store is a link
        items.push({ label: storeName, href: `/apps/${store}` });
      }
    }

    // Add registry level
    if (registry) {
      if (!appId) {
        // At registry level, registry is not a link
        items.push({ label: registryName || registry });
      } else {
        // At app level, registry is a link
        items.push({ label: registryName || registry, href: `/apps/${store}/${registry}` });
      }
    }

    // Add app level (always last, never a link)
    if (appId) {
      items.push({ label: getAppName() });
    }

    return items;
  };

  const breadcrumbItems = buildBreadcrumbItems();

  return (
    <div className="space-y-4">
      {/* Breadcrumb navigation - always visible */}
      <Breadcrumb items={breadcrumbItems} />
      <Outlet />
    </div>
  );
}
