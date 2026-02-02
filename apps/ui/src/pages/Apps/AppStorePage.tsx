import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { showSuccess, showError } from '../../lib/toast';
import {
  AppStoreHeader,
  AppGrid,
  RegistryList,
  RegistryModal,
  SearchFilter,
  type Registry,
  type CategoryCount,
  type DeploymentStatus,
} from '../../components/AppStore';
import type { StoreConfig, BaseApp } from './storeConfigs';

interface AppStorePageProps<TApp extends BaseApp> {
  config: StoreConfig<TApp>;
}

/**
 * Generic App Store page component that works with any store type.
 * Uses configuration to determine API methods and app normalization.
 */
export default function AppStorePage<TApp extends BaseApp>({
  config,
}: AppStorePageProps<TApp>) {
  const { registry: registryParam } = useParams<{ registry?: string }>();
  const queryClient = useQueryClient();
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showRegistryModal, setShowRegistryModal] = useState(false);

  // Fetch registries
  const { data: registriesData, isLoading: registriesLoading } = useQuery({
    queryKey: [config.queryKeys.registries],
    queryFn: () => config.api.getRegistries(),
  });

  const registries: Registry[] = registriesData?.registries || [];
  const enabledRegistries = registries.filter((r) => r.enabled);

  // Get selected registry from URL param
  const selectedRegistry = registryParam
    ? enabledRegistries.find((r) => r.id === registryParam)
    : undefined;

  // Fetch apps
  const {
    data: appsData,
    isLoading: appsLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: [config.queryKeys.apps],
    queryFn: () => config.api.getApps(),
    enabled: !!registryParam,
  });

  // Fetch deployments
  const { data: deploymentsData } = useQuery({
    queryKey: ['deployments'],
    queryFn: () => api.getDeployments(),
    enabled: !!registryParam,
  });

  // Sync mutation
  const syncMutation = useMutation({
    mutationFn: (registryId: string) => config.api.syncApps(registryId),
    onSuccess: (data) => {
      showSuccess(data.message || 'Synced apps');
      queryClient.invalidateQueries({ queryKey: [config.queryKeys.apps] });
      queryClient.invalidateQueries({ queryKey: [config.queryKeys.registries] });
    },
    onError: (err) =>
      showError(err instanceof Error ? err.message : 'Failed to sync'),
  });

  // Registry mutations
  const addRegistryMutation = useMutation({
    mutationFn: ({ id, name, url }: { id: string; name: string; url: string }) =>
      config.api.addRegistry(id, name, url),
    onSuccess: () => {
      showSuccess('Registry added');
      queryClient.invalidateQueries({ queryKey: [config.queryKeys.registries] });
    },
    onError: (err) =>
      showError(err instanceof Error ? err.message : 'Failed to add registry'),
  });

  const updateRegistryMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      config.api.updateRegistry(id, { enabled }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [config.queryKeys.registries] }),
    onError: (err) =>
      showError(err instanceof Error ? err.message : 'Failed to update registry'),
  });

  const removeRegistryMutation = useMutation({
    mutationFn: (id: string) => config.api.removeRegistry(id),
    onSuccess: () => {
      showSuccess('Registry removed');
      queryClient.invalidateQueries({ queryKey: [config.queryKeys.registries] });
      queryClient.invalidateQueries({ queryKey: [config.queryKeys.apps] });
    },
    onError: (err) =>
      showError(err instanceof Error ? err.message : 'Failed to remove registry'),
  });

  // Filter apps by registry
  const apps = (appsData?.apps || []) as TApp[];
  const filteredByRegistry = selectedRegistry
    ? apps.filter((app) => app.registry === selectedRegistry.id)
    : [];

  // Get categories
  const categories = useMemo((): CategoryCount[] => {
    const categoryMap = new Map<string, number>();
    filteredByRegistry.forEach((app) => {
      const cats = config.getCategories(app);
      cats.forEach((cat) => {
        categoryMap.set(cat, (categoryMap.get(cat) || 0) + 1);
      });
    });
    return Array.from(categoryMap.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
  }, [filteredByRegistry, config]);

  // Apply filters
  const filteredApps = useMemo(() => {
    let result = filteredByRegistry;

    if (selectedCategory) {
      result = result.filter((app) => config.matchCategory(app, selectedCategory));
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter((app) => config.filterApp(app, query));
    }

    return result.map(config.normalizeApp);
  }, [filteredByRegistry, selectedCategory, searchQuery, config]);

  // Deployments for status
  const deployments: DeploymentStatus[] = (deploymentsData?.deployments || []).map(
    (d) => ({
      appId: d.appId,
      status: d.status as DeploymentStatus['status'],
    })
  );

  const isLoading = registriesLoading || appsLoading;
  const hasFilters = !!searchQuery || !!selectedCategory;

  const handleSync = () => {
    if (selectedRegistry) {
      syncMutation.mutate(selectedRegistry.id);
    }
  };

  // If no registry selected, show registry list
  if (!registryParam) {
    return (
      <>
        <RegistryList
          storeType={config.storeType}
          registries={registries}
          isLoading={registriesLoading}
          onOpenSettings={() => setShowRegistryModal(true)}
        />

        {showRegistryModal && (
          <RegistryModal
            registries={registries}
            onClose={() => setShowRegistryModal(false)}
            onAdd={async (id, name, url) => {
              await addRegistryMutation.mutateAsync({ id, name, url });
            }}
            onToggle={async (id, enabled) => {
              await updateRegistryMutation.mutateAsync({ id, enabled });
            }}
            onRemove={async (id) => {
              await removeRegistryMutation.mutateAsync(id);
            }}
            isAdding={addRegistryMutation.isPending}
            urlPlaceholder={config.urlPlaceholder}
          />
        )}
      </>
    );
  }

  // Registry selected, show apps
  return (
    <div className="space-y-6">
      <AppStoreHeader
        appCount={filteredApps.length}
        onSync={handleSync}
        isSyncing={syncMutation.isPending}
        syncDisabled={!selectedRegistry}
      />

      <SearchFilter
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedCategory={selectedCategory}
        onCategoryChange={setSelectedCategory}
        categories={categories}
      />

      <AppGrid
        apps={filteredApps}
        storeType={config.storeType}
        deployments={deployments}
        isLoading={isLoading}
        error={error as Error | null}
        onRetry={() => refetch()}
        hasFilters={hasFilters}
        onSync={handleSync}
        isSyncing={syncMutation.isPending}
      />
    </div>
  );
}
