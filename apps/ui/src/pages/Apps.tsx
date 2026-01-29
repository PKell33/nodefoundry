import { useState, useEffect } from 'react';
import { useApps, useDeployments, useServers, useStartDeployment, useStopDeployment, useRestartDeployment, useUninstallDeployment } from '../hooks/useApi';
import { useAuthStore } from '../stores/useAuthStore';
import AppCard from '../components/AppCard';
import InstallModal from '../components/InstallModal';
import { api, Group } from '../api/client';

export default function Apps() {
  const { data: apps, isLoading: appsLoading } = useApps();
  const { data: deployments } = useDeployments();
  const { data: servers } = useServers();
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

  const getDeploymentForApp = (appName: string) => {
    return deployments?.find((d) => d.appName === appName);
  };

  const categories = ['bitcoin', 'lightning', 'indexer', 'explorer', 'utility'];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-2">Apps</h1>
        <p className="text-gray-400">Install and manage Bitcoin applications</p>
      </div>

      {appsLoading ? (
        <div className="text-gray-400">Loading...</div>
      ) : (
        categories.map((category) => {
          const categoryApps = apps?.filter((app) => app.category === category);
          if (!categoryApps?.length) return null;

          return (
            <section key={category}>
              <h2 className="text-lg font-semibold mb-4 capitalize">{category}</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {categoryApps.map((app) => {
                  const deployment = getDeploymentForApp(app.name);
                  return (
                    <AppCard
                      key={app.name}
                      app={app}
                      deployment={deployment}
                      groupName={deployment ? getGroupName(deployment.groupId) : undefined}
                      canManage={deployment ? canManageDeployment(deployment.groupId) : canInstall}
                      canOperate={deployment ? canOperateDeployment(deployment.groupId) : false}
                      onInstall={() => setInstallApp(app.name)}
                      onStart={() => deployment && startMutation.mutate(deployment.id)}
                      onStop={() => deployment && stopMutation.mutate(deployment.id)}
                      onRestart={() => deployment && restartMutation.mutate(deployment.id)}
                      onUninstall={() => {
                        if (deployment && confirm(`Uninstall ${app.displayName}? This will remove all data.`)) {
                          uninstallMutation.mutate(deployment.id);
                        }
                      }}
                    />
                  );
                })}
              </div>
            </section>
          );
        })
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
