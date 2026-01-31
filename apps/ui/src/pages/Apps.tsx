import { useState } from 'react';
import { useApps, useDeployments, useServers, useStartDeployment, useStopDeployment, useRestartDeployment, useUninstallDeployment } from '../hooks/useApi';
import { useAuthStore } from '../stores/useAuthStore';
import AppCard from '../components/AppCard';
import AppDetailModal from '../components/AppDetailModal';
import InstallModal from '../components/InstallModal';
import ConnectionInfoModal from '../components/ConnectionInfoModal';
import LogViewerModal from '../components/LogViewerModal';
import EditConfigModal from '../components/EditConfigModal';
import Modal from '../components/Modal';
import type { AppManifest, Deployment } from '../api/client';

type ConfirmAction = {
  type: 'stop' | 'restart' | 'uninstall';
  deploymentId: string;
  appName: string;
  serverName: string;
};

export default function Apps() {
  const { data: apps, isLoading: appsLoading } = useApps();
  const { data: deployments } = useDeployments();
  const { data: servers } = useServers();
  const [selectedApp, setSelectedApp] = useState<AppManifest | null>(null);
  const [installApp, setInstallApp] = useState<string | null>(null);
  const [connectionInfoDeploymentId, setConnectionInfoDeploymentId] = useState<string | null>(null);
  const [logsDeployment, setLogsDeployment] = useState<{ id: string; appName: string; serverName: string } | null>(null);
  const [editConfigDeployment, setEditConfigDeployment] = useState<{ deployment: Deployment; app: AppManifest } | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const { user } = useAuthStore();

  // Permission checks
  const canManage = user?.isSystemAdmin || user?.groups?.some(g => g.role === 'admin');
  const canOperate = user?.isSystemAdmin || user?.groups?.some(g => g.role === 'admin' || g.role === 'operator') || false;

  const startMutation = useStartDeployment();
  const stopMutation = useStopDeployment();
  const restartMutation = useRestartDeployment();
  const uninstallMutation = useUninstallDeployment();

  const getDeploymentsForApp = (appName: string): Deployment[] => {
    return deployments?.filter((d) => d.appName === appName) || [];
  };

  const getServerName = (serverId: string) => {
    const server = servers?.find(s => s.id === serverId);
    return server?.name || serverId;
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

  const handleConfirmAction = () => {
    if (!confirmAction) return;

    switch (confirmAction.type) {
      case 'stop':
        stopMutation.mutate(confirmAction.deploymentId);
        break;
      case 'restart':
        restartMutation.mutate(confirmAction.deploymentId);
        break;
      case 'uninstall':
        uninstallMutation.mutate(confirmAction.deploymentId);
        break;
    }
    setConfirmAction(null);
  };

  const getConfirmModalContent = () => {
    if (!confirmAction) return { title: '', message: '', buttonText: '', buttonClass: '' };

    switch (confirmAction.type) {
      case 'stop':
        return {
          title: `Stop ${confirmAction.appName} on ${confirmAction.serverName}?`,
          message: 'The app will be stopped and any active connections will be terminated.',
          buttonText: 'Stop',
          buttonClass: 'bg-yellow-600 hover:bg-yellow-700',
        };
      case 'restart':
        return {
          title: `Restart ${confirmAction.appName} on ${confirmAction.serverName}?`,
          message: 'The app will be restarted. This may briefly interrupt service.',
          buttonText: 'Restart',
          buttonClass: 'bg-blue-600 hover:bg-blue-700',
        };
      case 'uninstall':
        return {
          title: `Uninstall ${confirmAction.appName} from ${confirmAction.serverName}?`,
          message: 'This will remove the app and all its data from this server. This action cannot be undone.',
          buttonText: 'Uninstall',
          buttonClass: 'bg-red-600 hover:bg-red-700',
        };
    }
  };

  const categories = [
    { id: 'system', label: 'System' },
    { id: 'bitcoin', label: 'Bitcoin' },
    { id: 'indexer', label: 'Indexers' },
    { id: 'explorer', label: 'Explorers' },
    { id: 'database', label: 'Database' },
    { id: 'web', label: 'Web' },
    { id: 'networking', label: 'Networking' },
    { id: 'monitoring', label: 'Monitoring' },
    { id: 'utility', label: 'Utilities' },
  ];

  const selectedDeployments = selectedApp ? getDeploymentsForApp(selectedApp.name) : [];
  const selectedConflict = selectedApp ? getConflictingApp(selectedApp) : null;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold mb-2">Marketplace</h1>
        <p className="text-gray-400">Browse and install applications from the marketplace</p>
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
              <div className="grid grid-cols-1 xl:grid-cols-2 min-[1800px]:grid-cols-3 gap-4">
                {categoryApps.map((app) => {
                  const appDeployments = getDeploymentsForApp(app.name);
                  const conflictsWith = getConflictingApp(app);
                  return (
                    <AppCard
                      key={app.name}
                      app={app}
                      deployments={appDeployments}
                      servers={servers}
                      conflictsWith={conflictsWith}
                      onClick={() => setSelectedApp(app)}
                      canManage={canManage ?? false}
                      canOperate={canOperate}
                      onStart={(deploymentId) => startMutation.mutate(deploymentId)}
                      onStop={(deploymentId) => {
                        const deployment = appDeployments.find(d => d.id === deploymentId);
                        if (deployment) {
                          setConfirmAction({
                            type: 'stop',
                            deploymentId,
                            appName: app.displayName,
                            serverName: getServerName(deployment.serverId),
                          });
                        }
                      }}
                      onRestart={(deploymentId) => {
                        const deployment = appDeployments.find(d => d.id === deploymentId);
                        if (deployment) {
                          setConfirmAction({
                            type: 'restart',
                            deploymentId,
                            appName: app.displayName,
                            serverName: getServerName(deployment.serverId),
                          });
                        }
                      }}
                      onUninstall={(deploymentId) => {
                        const deployment = appDeployments.find(d => d.id === deploymentId);
                        if (deployment) {
                          setConfirmAction({
                            type: 'uninstall',
                            deploymentId,
                            appName: app.displayName,
                            serverName: getServerName(deployment.serverId),
                          });
                        }
                      }}
                      onConnectionInfo={(deploymentId) => setConnectionInfoDeploymentId(deploymentId)}
                      onSettings={(deployment) => setEditConfigDeployment({ deployment, app })}
                      onLogs={(deploymentId, serverName) => setLogsDeployment({ id: deploymentId, appName: app.displayName, serverName })}
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
          deployments={selectedDeployments}
          servers={servers}
          conflictsWith={selectedConflict}
          isOpen={!!selectedApp}
          onClose={() => setSelectedApp(null)}
          canManage={canManage ?? false}
          canOperate={canOperate}
          onInstall={() => {
            setInstallApp(selectedApp.name);
            setSelectedApp(null);
          }}
          onStart={(deploymentId) => startMutation.mutate(deploymentId)}
          onStop={(deploymentId) => stopMutation.mutate(deploymentId)}
          onRestart={(deploymentId) => restartMutation.mutate(deploymentId)}
          onUninstall={(deploymentId) => uninstallMutation.mutate(deploymentId)}
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

      {/* Confirm Action Modal */}
      {confirmAction && (
        <Modal
          isOpen={!!confirmAction}
          onClose={() => setConfirmAction(null)}
          title={getConfirmModalContent().title}
          size="sm"
        >
          <div className="space-y-4">
            <p className="text-[var(--text-secondary)]">
              {getConfirmModalContent().message}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmAction(null)}
                className="flex-1 px-4 py-2 bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmAction}
                className={`flex-1 px-4 py-2 text-white rounded transition-colors ${getConfirmModalContent().buttonClass}`}
              >
                {getConfirmModalContent().buttonText}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Connection Info Modal */}
      {connectionInfoDeploymentId && (
        <ConnectionInfoModal
          deploymentId={connectionInfoDeploymentId}
          isOpen={!!connectionInfoDeploymentId}
          onClose={() => setConnectionInfoDeploymentId(null)}
        />
      )}

      {/* Log Viewer Modal */}
      {logsDeployment && (
        <LogViewerModal
          deploymentId={logsDeployment.id}
          appName={`${logsDeployment.appName} (${logsDeployment.serverName})`}
          isOpen={!!logsDeployment}
          onClose={() => setLogsDeployment(null)}
        />
      )}

      {/* Edit Config Modal */}
      {editConfigDeployment && (
        <EditConfigModal
          deployment={editConfigDeployment.deployment}
          app={editConfigDeployment.app}
          isOpen={!!editConfigDeployment}
          onClose={() => setEditConfigDeployment(null)}
        />
      )}
    </div>
  );
}
