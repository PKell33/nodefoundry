import { useState, useEffect } from 'react';
import { useApps, useDeployments, useServers, useStartDeployment, useStopDeployment, useRestartDeployment, useUninstallDeployment } from '../hooks/useApi';
import { useAuthStore } from '../stores/useAuthStore';
import AppCard from '../components/AppCard';
import AppDetailModal from '../components/AppDetailModal';
import InstallModal from '../components/InstallModal';
import { api, Group, AppManifest, Deployment } from '../api/client';

export default function Apps() {
  const { data: apps, isLoading: appsLoading } = useApps();
  const { data: deployments } = useDeployments();
  const { data: servers } = useServers();
  const [selectedApp, setSelectedApp] = useState<AppManifest | null>(null);
  const [installApp, setInstallApp] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const { user } = useAuthStore();

  // Fetch groups for name lookup
  useEffect(() => {
    const fetchGroups = async () => {
      try {
        const data = await api.getGroups();
        setGroups(data);
      } catch (err) {
        console.error('Failed to fetch groups:', err);
      }
    };
    fetchGroups();
  }, []);

  // Get group name by ID
  const getGroupName = (groupId?: string) => {
    if (!groupId) return 'Default';
    const group = groups.find(g => g.id === groupId);
    return group?.name || groupId;
  };

  // Permission checks per deployment - based on deployment's group
  const canManageDeployment = (groupId?: string) => {
    if (user?.isSystemAdmin) return true;
    const gid = groupId || 'default';
    const membership = user?.groups?.find(g => g.groupId === gid);
    return membership?.role === 'admin';
  };

  const canOperateDeployment = (groupId?: string) => {
    if (user?.isSystemAdmin) return true;
    const gid = groupId || 'default';
    const membership = user?.groups?.find(g => g.groupId === gid);
    return membership?.role === 'admin' || membership?.role === 'operator';
  };

  // For install button, check if user can manage any group
  const canInstall = user?.isSystemAdmin || user?.groups?.some(g => g.role === 'admin');

  const startMutation = useStartDeployment();
  const stopMutation = useStopDeployment();
  const restartMutation = useRestartDeployment();
  const uninstallMutation = useUninstallDeployment();

  const getDeploymentForApp = (appName: string): Deployment | undefined => {
    return deployments?.find((d) => d.appName === appName);
  };

  // Check if an app conflicts with any installed app
  const getConflictingApp = (app: AppManifest): string | null => {
    if (!app.conflicts || !deployments) return null;
    for (const conflictName of app.conflicts) {
      const installed = deployments.find(d => d.appName === conflictName);
      if (installed) {
        const conflictApp = apps?.find(a => a.name === conflictName);
        return conflictApp?.displayName || conflictName;
      }
    }
    return null;
  };

  const categories = [
    { id: 'bitcoin', label: 'Bitcoin' },
    { id: 'lightning', label: 'Lightning' },
    { id: 'indexer', label: 'Indexers' },
    { id: 'explorer', label: 'Explorers' },
    { id: 'utility', label: 'Utilities' },
  ];

  const selectedDeployment = selectedApp ? getDeploymentForApp(selectedApp.name) : undefined;
  const selectedConflict = selectedApp ? getConflictingApp(selectedApp) : null;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold mb-2">Marketplace</h1>
        <p className="text-gray-400">Browse and install Bitcoin applications</p>
      </div>

      {appsLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-gray-400">Loading apps...</div>
        </div>
      ) : (
        categories.map((category) => {
          const categoryApps = apps?.filter((app) => app.category === category.id);
          if (!categoryApps?.length) return null;

          return (
            <section key={category.id}>
              <h2 className="text-xl font-semibold mb-4">{category.label}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {categoryApps.map((app) => {
                  const deployment = getDeploymentForApp(app.name);
                  const conflictsWith = getConflictingApp(app);
                  return (
                    <AppCard
                      key={app.name}
                      app={app}
                      deployment={deployment}
                      conflictsWith={conflictsWith}
                      onClick={() => setSelectedApp(app)}
                    />
                  );
                })}
              </div>
            </section>
          );
        })
      )}

      {/* App Detail Modal */}
      {selectedApp && (
        <AppDetailModal
          app={selectedApp}
          deployment={selectedDeployment}
          groupName={selectedDeployment ? getGroupName(selectedDeployment.groupId) : undefined}
          conflictsWith={selectedConflict}
          isOpen={!!selectedApp}
          onClose={() => setSelectedApp(null)}
          canManage={selectedDeployment ? canManageDeployment(selectedDeployment.groupId) : (canInstall && !selectedConflict)}
          canOperate={selectedDeployment ? canOperateDeployment(selectedDeployment.groupId) : false}
          onInstall={() => {
            setInstallApp(selectedApp.name);
            setSelectedApp(null);
          }}
          onStart={() => selectedDeployment && startMutation.mutate(selectedDeployment.id)}
          onStop={() => selectedDeployment && stopMutation.mutate(selectedDeployment.id)}
          onRestart={() => selectedDeployment && restartMutation.mutate(selectedDeployment.id)}
          onUninstall={() => {
            if (selectedDeployment && confirm(`Uninstall ${selectedApp.displayName}? This will remove all data.`)) {
              uninstallMutation.mutate(selectedDeployment.id);
              setSelectedApp(null);
            }
          }}
        />
      )}

      {/* Install Modal */}
      {installApp && (
        <InstallModal
          appName={installApp}
          servers={servers || []}
          onClose={() => setInstallApp(null)}
        />
      )}
    </div>
  );
}
