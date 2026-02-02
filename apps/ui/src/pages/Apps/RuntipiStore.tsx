import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type RuntipiApp, type UmbrelApp } from '../../api/client';
import { showSuccess, showError } from '../../lib/toast';
import { InstallModal } from '../../components/InstallModal';
import { AppDetailModal } from '../../components/AppDetailModal';
import {
  AppStoreHeader,
  AppGrid,
  RegistryTabs,
  RegistryModal,
  SearchFilter,
  type NormalizedApp,
  type Registry,
  type CategoryCount,
  type DeploymentStatus,
} from '../../components/AppStore';

/**
 * Runtipi App Store
 */
export default function RuntipiStore() {
  const queryClient = useQueryClient();
  const [selectedRegistryId, setSelectedRegistryId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedApp, setSelectedApp] = useState<NormalizedApp | null>(null);
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showRegistryModal, setShowRegistryModal] = useState(false);

  // Fetch registries
  const { data: registriesData, isLoading: registriesLoading } = useQuery({
    queryKey: ['runtipiRegistries'],
    queryFn: () => api.getRuntipiRegistries(),
  });

  const registries: Registry[] = registriesData?.registries || [];
  const enabledRegistries = registries.filter(r => r.enabled);
  const selectedRegistry = selectedRegistryId
    ? enabledRegistries.find(r => r.id === selectedRegistryId)
    : enabledRegistries[0];

  // Fetch apps
  const { data: appsData, isLoading: appsLoading, error, refetch } = useQuery({
    queryKey: ['runtipiApps'],
    queryFn: () => api.getRuntipiApps(),
  });

  // Fetch servers
  const { data: servers } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.getServers(),
  });

  // Fetch deployments
  const { data: deploymentsData } = useQuery({
    queryKey: ['deployments'],
    queryFn: () => api.getDeployments(),
  });

  // Sync mutation
  const syncMutation = useMutation({
    mutationFn: (registryId: string) => api.syncRuntipiApps(registryId),
    onSuccess: (data) => {
      showSuccess(data.message || 'Synced apps');
      queryClient.invalidateQueries({ queryKey: ['runtipiApps'] });
      queryClient.invalidateQueries({ queryKey: ['runtipiRegistries'] });
    },
    onError: (err) => showError(err instanceof Error ? err.message : 'Failed to sync'),
  });

  // Registry mutations
  const addRegistryMutation = useMutation({
    mutationFn: ({ id, name, url }: { id: string; name: string; url: string }) =>
      api.addRuntipiRegistry(id, name, url),
    onSuccess: () => {
      showSuccess('Registry added');
      queryClient.invalidateQueries({ queryKey: ['runtipiRegistries'] });
    },
    onError: (err) => showError(err instanceof Error ? err.message : 'Failed to add registry'),
  });

  const updateRegistryMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateRuntipiRegistry(id, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['runtipiRegistries'] }),
    onError: (err) => showError(err instanceof Error ? err.message : 'Failed to update registry'),
  });

  const removeRegistryMutation = useMutation({
    mutationFn: (id: string) => api.removeRuntipiRegistry(id),
    onSuccess: () => {
      showSuccess('Registry removed');
      queryClient.invalidateQueries({ queryKey: ['runtipiRegistries'] });
      queryClient.invalidateQueries({ queryKey: ['runtipiApps'] });
    },
    onError: (err) => showError(err instanceof Error ? err.message : 'Failed to remove registry'),
  });

  // Deploy mutation
  const deployMutation = useMutation({
    mutationFn: ({ serverId, appId }: { serverId: string; appId: string }) =>
      api.deployApp(serverId, appId),
    onSuccess: (data) => {
      showSuccess(`Deploying ${data.appName}`);
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      setShowInstallModal(false);
      setSelectedApp(null);
    },
    onError: (err) => showError(err instanceof Error ? err.message : 'Failed to deploy app'),
  });

  // Normalize Runtipi app to common format
  const normalizeApp = (app: RuntipiApp): NormalizedApp => ({
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
  });

  // Convert to UmbrelApp for install modal compatibility
  const toUmbrelApp = (app: NormalizedApp): UmbrelApp => {
    const original = app.original as RuntipiApp;
    return {
      id: app.id,
      name: app.name,
      version: app.version,
      tagline: app.tagline,
      description: app.description,
      category: app.category,
      developer: app.developer,
      website: original.source || '',
      repo: original.source || '',
      port: app.port,
      dependencies: [],
      icon: app.icon,
      gallery: [],
      composeFile: original.composeFile || '',
      source: 'runtipi',
      manifest: {
        manifestVersion: 1,
        id: app.id,
        category: app.category,
        name: app.name,
        version: app.version,
        tagline: app.tagline,
        description: app.description,
        developer: app.developer,
        website: original.source || '',
        dependencies: [],
        repo: original.source || '',
        support: '',
        port: app.port,
        gallery: [],
        path: '',
      },
    };
  };

  // Filter apps
  const apps = appsData?.apps || [];
  const filteredByRegistry = selectedRegistry
    ? apps.filter(app => app.registry === selectedRegistry.id)
    : apps;

  // Get categories
  const categories = useMemo((): CategoryCount[] => {
    const categoryMap = new Map<string, number>();
    filteredByRegistry.forEach(app => {
      const cats = app.categories || ['Uncategorized'];
      cats.forEach(cat => {
        categoryMap.set(cat, (categoryMap.get(cat) || 0) + 1);
      });
    });
    return Array.from(categoryMap.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
  }, [filteredByRegistry]);

  // Apply filters
  const filteredApps = useMemo(() => {
    let result = filteredByRegistry;

    if (selectedCategory) {
      result = result.filter(app => app.categories?.includes(selectedCategory));
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(app =>
        app.name.toLowerCase().includes(query) ||
        app.shortDesc?.toLowerCase().includes(query) ||
        app.description?.toLowerCase().includes(query)
      );
    }

    return result.map(normalizeApp);
  }, [filteredByRegistry, selectedCategory, searchQuery]);

  // Deployments for status
  const deployments: DeploymentStatus[] = (deploymentsData?.deployments || []).map(d => ({
    appId: d.appId,
    status: d.status as DeploymentStatus['status'],
  }));

  const isLoading = registriesLoading || appsLoading;
  const hasFilters = !!searchQuery || !!selectedCategory;

  const handleSync = () => {
    if (selectedRegistry) {
      syncMutation.mutate(selectedRegistry.id);
    }
  };

  const handleViewDetails = (app: NormalizedApp) => {
    setSelectedApp(app);
    setShowDetailModal(true);
  };

  const handleInstall = (app: NormalizedApp) => {
    setSelectedApp(app);
    setShowInstallModal(true);
  };

  return (
    <div className="space-y-6">
      <AppStoreHeader
        title="Runtipi App Store"
        appCount={filteredApps.length}
        onSync={handleSync}
        isSyncing={syncMutation.isPending}
        syncDisabled={!selectedRegistry}
        onOpenSettings={() => setShowRegistryModal(true)}
      />

      <RegistryTabs
        registries={enabledRegistries}
        selectedRegistryId={selectedRegistry?.id}
        onSelectRegistry={(id) => {
          setSelectedRegistryId(id);
          setSelectedCategory('');
        }}
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
        deployments={deployments}
        isLoading={isLoading}
        error={error as Error | null}
        onRetry={() => refetch()}
        onViewDetails={handleViewDetails}
        onInstall={handleInstall}
        hasFilters={hasFilters}
        onSync={handleSync}
        isSyncing={syncMutation.isPending}
      />

      {showInstallModal && selectedApp && servers && (
        <InstallModal
          app={toUmbrelApp(selectedApp)}
          servers={servers}
          onInstall={(serverId) => {
            deployMutation.mutate({ serverId, appId: selectedApp.id });
          }}
          onClose={() => {
            setShowInstallModal(false);
            setSelectedApp(null);
          }}
          isInstalling={deployMutation.isPending}
        />
      )}

      {showDetailModal && selectedApp && (
        <AppDetailModal
          app={toUmbrelApp(selectedApp)}
          servers={servers || []}
          isInstalled={deployments.some(d => d.appId === selectedApp.id)}
          deploymentStatus={deployments.find(d => d.appId === selectedApp.id)?.status}
          onClose={() => {
            setShowDetailModal(false);
            setSelectedApp(null);
          }}
          onInstall={() => {
            setShowDetailModal(false);
            setShowInstallModal(true);
          }}
        />
      )}

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
        />
      )}
    </div>
  );
}
