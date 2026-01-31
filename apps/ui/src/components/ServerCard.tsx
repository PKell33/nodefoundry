import { Server, Cpu, HardDrive, MemoryStick, Trash2, MoreVertical, FileText, KeyRound, Play, Square, ExternalLink, Link, Settings, FileText as LogsIcon, RotateCw, Plus, Network } from 'lucide-react';
import { Sparkline } from './MetricsChart';
import { useState, useCallback, useMemo, memo } from 'react';
import type { Server as ServerType, Deployment, AppManifest } from '../api/client';
import StatusBadge from './StatusBadge';
import AppIcon from './AppIcon';
import AppDetailModal from './AppDetailModal';
import ConnectionInfoModal from './ConnectionInfoModal';
import LogViewerModal from './LogViewerModal';
import EditConfigModal from './EditConfigModal';
import InstallModal from './InstallModal';
import Modal from './Modal';

interface ServerCardProps {
  server: ServerType;
  deployments?: Deployment[];
  apps?: AppManifest[];
  onClick?: () => void;
  onDelete?: () => void;
  onRegenerate?: () => void;
  onViewGuide?: () => void;
  onStartApp?: (deploymentId: string) => void;
  onStopApp?: (deploymentId: string) => void;
  onRestartApp?: (deploymentId: string) => void;
  onUninstallApp?: (deploymentId: string, appName: string) => void;
  canManage?: boolean;
  canOperate?: boolean;
}

type ConfirmAction = {
  type: 'stop' | 'restart' | 'uninstall';
  deploymentId: string;
  appName: string;
};

/**
 * ServerCard - Displays server info, metrics, and deployed apps.
 * Wrapped in React.memo to prevent re-renders when parent state changes
 * but this server's data hasn't changed.
 */
const ServerCard = memo(function ServerCard({
  server,
  deployments = [],
  apps = [],
  onClick,
  onDelete,
  onRegenerate,
  onViewGuide,
  onStartApp,
  onStopApp,
  onRestartApp,
  onUninstallApp,
  canManage = false,
  canOperate = false,
}: ServerCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [selectedApp, setSelectedApp] = useState<{ app: AppManifest; deployment: Deployment } | null>(null);
  const [connectionInfoDeployment, setConnectionInfoDeployment] = useState<Deployment | null>(null);
  const [logsDeployment, setLogsDeployment] = useState<{ deployment: Deployment; appName: string } | null>(null);
  const [editConfigData, setEditConfigData] = useState<{ deployment: Deployment; app: AppManifest } | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [showAddAppModal, setShowAddAppModal] = useState(false);
  const [installAppName, setInstallAppName] = useState<string | null>(null);
  const metrics = server.metrics;

  // Memoize expensive computations
  const installedAppNames = useMemo(() => deployments.map(d => d.appName), [deployments]);

  // Available apps = not installed and not mandatory
  const availableApps = useMemo(() =>
    apps.filter(app => !installedAppNames.includes(app.name) && !app.mandatory),
    [apps, installedAppNames]
  );

  // Group available apps by category
  const appsByCategory = useMemo(() =>
    availableApps.reduce((acc, app) => {
      const category = app.category || 'other';
      if (!acc[category]) acc[category] = [];
      acc[category].push(app);
      return acc;
    }, {} as Record<string, AppManifest[]>),
    [availableApps]
  );

  // Define category order (system first, then others)
  const categoryOrder = useMemo(() =>
    ['system', 'database', 'web', 'networking', 'monitoring', 'utility', 'other'],
    []
  );

  // Sort deployments: system apps first
  const sortedDeployments = useMemo(() => {
    const getApp = (appName: string) => apps.find(a => a.name === appName);
    return [...deployments].sort((a, b) => {
      const appA = getApp(a.appName);
      const appB = getApp(b.appName);
      if (appA?.system && !appB?.system) return -1;
      if (!appA?.system && appB?.system) return 1;
      return 0;
    });
  }, [deployments, apps]);

  // Memoize callback for looking up apps
  const getAppForDeployment = useCallback((appName: string): AppManifest | undefined => {
    return apps.find(a => a.name === appName);
  }, [apps]);

  // Memoize event handlers to prevent child re-renders
  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete?.();
      setConfirmDelete(false);
      setShowMenu(false);
    } else {
      setConfirmDelete(true);
      setConfirmRegenerate(false);
    }
  }, [confirmDelete, onDelete]);

  const handleViewGuide = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onViewGuide?.();
    setShowMenu(false);
  }, [onViewGuide]);

  const handleRegenerate = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirmRegenerate) {
      setConfirmRegenerate(true);
      setConfirmDelete(false);
      return;
    }
    onRegenerate?.();
    setConfirmRegenerate(false);
    setShowMenu(false);
  }, [confirmRegenerate, onRegenerate]);

  const handleAppClick = useCallback((deployment: Deployment, e: React.MouseEvent) => {
    e.stopPropagation();
    const app = getAppForDeployment(deployment.appName);
    if (app) {
      setSelectedApp({ app, deployment });
    }
  }, [getAppForDeployment]);

  const handleConfirmAction = useCallback(() => {
    if (!confirmAction) return;

    switch (confirmAction.type) {
      case 'stop':
        onStopApp?.(confirmAction.deploymentId);
        break;
      case 'restart':
        onRestartApp?.(confirmAction.deploymentId);
        break;
      case 'uninstall':
        onUninstallApp?.(confirmAction.deploymentId, confirmAction.appName);
        break;
    }
    setConfirmAction(null);
  }, [confirmAction, onStopApp, onRestartApp, onUninstallApp]);

  const handleMenuToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(prev => !prev);
    setConfirmDelete(false);
    setConfirmRegenerate(false);
  }, []);

  const handleMenuClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(false);
    setConfirmDelete(false);
    setConfirmRegenerate(false);
  }, []);

  const handleAddAppClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowAddAppModal(true);
  }, []);

  const getConfirmModalContent = useCallback(() => {
    if (!confirmAction) return { title: '', message: '', buttonText: '', buttonClass: '' };

    switch (confirmAction.type) {
      case 'stop':
        return {
          title: `Stop ${confirmAction.appName}?`,
          message: 'The app will be stopped and any active connections will be terminated.',
          buttonText: 'Stop',
          buttonClass: 'bg-yellow-600 hover:bg-yellow-700',
        };
      case 'restart':
        return {
          title: `Restart ${confirmAction.appName}?`,
          message: 'The app will be restarted. This may briefly interrupt service.',
          buttonText: 'Restart',
          buttonClass: 'bg-blue-600 hover:bg-blue-700',
        };
      case 'uninstall':
        return {
          title: `Uninstall ${confirmAction.appName}?`,
          message: 'This will remove the app and all its data. This action cannot be undone.',
          buttonText: 'Uninstall',
          buttonClass: 'bg-red-600 hover:bg-red-700',
        };
    }
  }, [confirmAction]);

  return (
    <div
      onClick={onClick}
      className={`card p-3 md:p-4 ${
        onClick ? 'cursor-pointer card-hover' : ''
      }`}
    >
      <div className="flex items-start justify-between mb-2 md:mb-3">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <div className="p-1.5 md:p-2 rounded-lg flex-shrink-0 bg-[var(--bg-secondary)]">
            <Server size={18} className={server.isCore ? 'text-accent' : 'text-muted'} />
          </div>
          <div className="min-w-0">
            <h3 className="font-medium text-sm md:text-base truncate">{server.name}</h3>
            <p className="text-xs md:text-sm text-muted truncate">
              {server.isCore ? 'Orchestrator' : server.host || 'Unknown'}
            </p>
            {server.networkInfo?.ipAddress && (
              <p className="text-xs text-muted truncate flex items-center gap-1">
                <Network size={10} className="flex-shrink-0" />
                <span>{server.networkInfo.ipAddress}</span>
                {server.networkInfo.macAddress && (
                  <span className="opacity-60">({server.networkInfo.macAddress})</span>
                )}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={server.agentStatus} />
          {canManage && !server.isCore && (
            <div className="relative">
              <button
                onClick={handleMenuToggle}
                className="p-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
                aria-label="Server options menu"
                aria-expanded={showMenu}
                aria-haspopup="menu"
              >
                <MoreVertical size={16} aria-hidden="true" />
              </button>
              {showMenu && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={handleMenuClose}
                  />
                  <div className="absolute right-0 top-full mt-1 z-20 py-1 rounded-lg shadow-lg min-w-[180px]
                    bg-[var(--bg-secondary)] border border-[var(--border-color)]">
                    <button
                      onClick={handleViewGuide}
                      className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors
                        text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                    >
                      <FileText size={14} />
                      Setup Guide
                    </button>
                    <button
                      onClick={handleRegenerate}
                      className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors
                        ${confirmRegenerate
                          ? 'text-yellow-500 hover:bg-yellow-500/10'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                        }`}
                    >
                      <KeyRound size={14} />
                      {confirmRegenerate ? 'Confirm (invalidates token)' : 'Generate New Token'}
                    </button>
                    <div className="my-1 border-t border-[var(--border-color)]" />
                    <button
                      onClick={handleDelete}
                      className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors
                        text-red-500 hover:bg-red-500/10"
                    >
                      <Trash2 size={14} />
                      {confirmDelete ? 'Confirm Delete' : 'Delete Server'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {metrics && server.agentStatus === 'online' && (
        <div className="grid grid-cols-3 gap-1 md:gap-2 mt-2 md:mt-3 pt-2 md:pt-3 border-t border-[var(--border-color)]">
          <MetricItem
            icon={<Cpu size={12} />}
            label="CPU"
            value={`${metrics.cpuPercent}%`}
            sparkline={<Sparkline serverId={server.id} metric="cpu" />}
          />
          <MetricItem
            icon={<MemoryStick size={12} />}
            label="RAM"
            value={formatBytes(metrics.memoryUsed)}
            sparkline={<Sparkline serverId={server.id} metric="memory" total={metrics.memoryTotal} />}
          />
          <MetricItem
            icon={<HardDrive size={12} />}
            label="Disk"
            value={formatBytes(metrics.diskUsed)}
            sparkline={<Sparkline serverId={server.id} metric="disk" total={metrics.diskTotal} />}
          />
        </div>
      )}

      <div className="mt-2 md:mt-3 pt-2 md:pt-3 border-t border-[var(--border-color)]">
        {sortedDeployments.length > 0 ? (
          <div className="space-y-2">
            {sortedDeployments.map((deployment) => (
              <DeploymentItem
                key={deployment.id}
                deployment={deployment}
                app={getAppForDeployment(deployment.appName)}
                canManage={canManage}
                canOperate={canOperate}
                onAppClick={handleAppClick}
                onStartApp={onStartApp}
                onSetConfirmAction={setConfirmAction}
                onSetConnectionInfo={setConnectionInfoDeployment}
                onSetLogsDeployment={setLogsDeployment}
                onSetEditConfigData={setEditConfigData}
              />
            ))}
          </div>
        ) : (
          <span className="text-xs md:text-sm text-muted">No apps deployed</span>
        )}

        {/* Add App Button - at the bottom */}
        {canManage && server.agentStatus === 'online' && availableApps.length > 0 && (
          <button
            onClick={handleAddAppClick}
            className="w-full mt-2 px-3 py-2 flex items-center justify-center gap-2 text-sm rounded-lg border border-dashed border-[var(--border-color)] hover:border-accent hover:text-accent transition-colors text-muted"
          >
            <Plus size={16} />
            Add App
          </button>
        )}
      </div>

      {/* App Detail Modal */}
      {selectedApp && (
        <AppDetailModal
          app={selectedApp.app}
          deployments={[selectedApp.deployment]}
          servers={[server]}
          isOpen={!!selectedApp}
          onClose={() => setSelectedApp(null)}
          canManage={canManage}
          canOperate={canOperate}
          onStart={(deploymentId) => onStartApp?.(deploymentId)}
          onStop={(deploymentId) => {
            setConfirmAction({
              type: 'stop',
              deploymentId,
              appName: selectedApp.app.displayName,
            });
          }}
          onRestart={(deploymentId) => {
            setConfirmAction({
              type: 'restart',
              deploymentId,
              appName: selectedApp.app.displayName,
            });
          }}
          onUninstall={(deploymentId) => {
            setConfirmAction({
              type: 'uninstall',
              deploymentId,
              appName: selectedApp.app.displayName,
            });
          }}
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
      {connectionInfoDeployment && (
        <ConnectionInfoModal
          deploymentId={connectionInfoDeployment.id}
          isOpen={!!connectionInfoDeployment}
          onClose={() => setConnectionInfoDeployment(null)}
        />
      )}

      {/* Log Viewer Modal */}
      {logsDeployment && (
        <LogViewerModal
          deploymentId={logsDeployment.deployment.id}
          appName={logsDeployment.appName}
          isOpen={!!logsDeployment}
          onClose={() => setLogsDeployment(null)}
        />
      )}

      {/* Edit Config Modal */}
      {editConfigData && (
        <EditConfigModal
          deployment={editConfigData.deployment}
          app={editConfigData.app}
          isOpen={!!editConfigData}
          onClose={() => setEditConfigData(null)}
        />
      )}

      {/* Add App Selector Modal */}
      {showAddAppModal && (
        <Modal
          isOpen={showAddAppModal}
          onClose={() => setShowAddAppModal(false)}
          title="Add App"
          size="lg"
        >
          <div className="space-y-4">
            <p className="text-[var(--text-secondary)] text-sm">
              Select an app to install on <span className="font-medium text-[var(--text-primary)]">{server.name}</span>
            </p>

            {Object.keys(appsByCategory).length === 0 ? (
              <div className="text-center py-8 text-muted">
                All available apps are already installed on this server.
              </div>
            ) : (
              <div className="space-y-4 max-h-[60vh] overflow-y-auto">
                {categoryOrder
                  .filter(cat => appsByCategory[cat]?.length > 0)
                  .map((category) => (
                  <div key={category}>
                    <h3 className="text-sm font-medium text-muted mb-2 capitalize">{category}</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {appsByCategory[category].map((app) => (
                        <AppSelectButton
                          key={app.name}
                          app={app}
                          onSelect={() => {
                            setShowAddAppModal(false);
                            setInstallAppName(app.name);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="pt-4 border-t border-[var(--border-color)]">
              <button
                onClick={() => setShowAddAppModal(false)}
                className="w-full px-4 py-2 bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] rounded transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Install Modal */}
      {installAppName && (
        <InstallModal
          appName={installAppName}
          servers={[server]}
          onClose={() => setInstallAppName(null)}
        />
      )}
    </div>
  );
});

export default ServerCard;

// Memoized sub-component for app selection in modal
const AppSelectButton = memo(function AppSelectButton({
  app,
  onSelect,
}: {
  app: AppManifest;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`flex items-center gap-3 p-3 rounded-lg border transition-colors text-left ${
        app.system
          ? 'border-purple-500/30 hover:border-purple-500 hover:bg-purple-500/10'
          : 'border-[var(--border-color)] hover:border-accent hover:bg-accent/5'
      }`}
    >
      <AppIcon appName={app.name} size={32} />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm truncate flex items-center gap-2">
          {app.displayName}
          {app.system && (
            <span className="text-[10px] bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded">System</span>
          )}
        </div>
        <div className="text-xs text-muted truncate">{app.description}</div>
      </div>
    </button>
  );
});

// Memoized deployment item - prevents re-render when other deployments change
interface DeploymentItemProps {
  deployment: Deployment;
  app: AppManifest | undefined;
  canManage: boolean;
  canOperate: boolean;
  onAppClick: (deployment: Deployment, e: React.MouseEvent) => void;
  onStartApp?: (deploymentId: string) => void;
  onSetConfirmAction: (action: ConfirmAction) => void;
  onSetConnectionInfo: (deployment: Deployment) => void;
  onSetLogsDeployment: (data: { deployment: Deployment; appName: string }) => void;
  onSetEditConfigData: (data: { deployment: Deployment; app: AppManifest }) => void;
}

const DeploymentItem = memo(function DeploymentItem({
  deployment,
  app,
  canManage,
  canOperate,
  onAppClick,
  onStartApp,
  onSetConfirmAction,
  onSetConnectionInfo,
  onSetLogsDeployment,
  onSetEditConfigData,
}: DeploymentItemProps) {
  const appDisplayName = app?.displayName || formatAppName(deployment.appName);
  const isRunning = deployment.status === 'running';
  const canControl = !['installing', 'configuring', 'uninstalling'].includes(deployment.status);
  const hasServices = app?.provides && app.provides.length > 0;
  const hasEditableConfig = app?.configSchema?.some(f => !f.generated && !f.inheritFrom) ?? false;
  const isSystemApp = app?.system ?? false;

  const handleStart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onStartApp?.(deployment.id);
  }, [onStartApp, deployment.id]);

  const handleStop = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSetConfirmAction({ type: 'stop', deploymentId: deployment.id, appName: appDisplayName });
  }, [onSetConfirmAction, deployment.id, appDisplayName]);

  const handleRestart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSetConfirmAction({ type: 'restart', deploymentId: deployment.id, appName: appDisplayName });
  }, [onSetConfirmAction, deployment.id, appDisplayName]);

  const handleUninstall = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSetConfirmAction({ type: 'uninstall', deploymentId: deployment.id, appName: appDisplayName });
  }, [onSetConfirmAction, deployment.id, appDisplayName]);

  const handleConnectionInfo = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSetConnectionInfo(deployment);
  }, [onSetConnectionInfo, deployment]);

  const handleLogs = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSetLogsDeployment({ deployment, appName: appDisplayName });
  }, [onSetLogsDeployment, deployment, appDisplayName]);

  const handleSettings = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (app) {
      onSetEditConfigData({ deployment, app });
    }
  }, [onSetEditConfigData, deployment, app]);

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 p-2 rounded-lg ${
        isSystemApp
          ? 'bg-purple-500/10 border border-purple-500/20'
          : 'bg-[var(--bg-secondary)]'
      }`}
    >
      {/* App icon - clickable */}
      <button
        onClick={(e) => onAppClick(deployment, e)}
        className="flex items-center gap-2 flex-shrink-0 hover:opacity-80 transition-opacity"
        title={`View ${appDisplayName} details`}
      >
        <AppIcon appName={deployment.appName} size={20} />
        <span className="text-sm">{appDisplayName}</span>
        <StatusBadge status={deployment.status} size="sm" />
      </button>

      {/* Action buttons */}
      <div className="flex items-center gap-1">
        {/* Start button */}
        {canControl && canOperate && !isRunning && (
          <button
            onClick={handleStart}
            title="Start"
            className="p-1.5 rounded hover:bg-green-600/20 text-green-500 transition-colors"
          >
            <Play size={14} />
          </button>
        )}

        {/* Stop button */}
        {canControl && canOperate && isRunning && (
          <button
            onClick={handleStop}
            title="Stop"
            className="p-1.5 rounded hover:bg-yellow-600/20 text-yellow-500 transition-colors"
          >
            <Square size={14} />
          </button>
        )}

        {/* Restart button */}
        {canControl && canOperate && isRunning && (
          <button
            onClick={handleRestart}
            title="Restart"
            className="p-1.5 rounded hover:bg-blue-600/20 text-blue-500 transition-colors"
          >
            <RotateCw size={14} />
          </button>
        )}

        {/* Open Web UI */}
        {app?.webui?.enabled && isRunning && (
          <a
            href={app.webui.basePath}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Open Web UI"
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
          >
            <ExternalLink size={14} />
          </a>
        )}

        {/* Connection Info */}
        {hasServices && canManage && (
          <button
            onClick={handleConnectionInfo}
            title="Connection Info"
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
          >
            <Link size={14} />
          </button>
        )}

        {/* Settings */}
        {hasEditableConfig && canManage && app && (
          <button
            onClick={handleSettings}
            title="Settings"
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
          >
            <Settings size={14} />
          </button>
        )}

        {/* View Logs */}
        {canOperate && (
          <button
            onClick={handleLogs}
            title="View Logs"
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
          >
            <LogsIcon size={14} />
          </button>
        )}

        {/* Uninstall button - hidden for mandatory system apps */}
        {canControl && canManage && !app?.mandatory && (
          <button
            onClick={handleUninstall}
            title="Uninstall"
            className="p-1.5 rounded hover:bg-red-600/20 text-red-500 transition-colors"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
});

// Memoized metric item component
const MetricItem = memo(function MetricItem({
  icon,
  label,
  value,
  sparkline
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sparkline?: React.ReactNode;
}) {
  return (
    <div className="text-center">
      <div className="flex items-center justify-center gap-1 text-muted mb-0.5 md:mb-1">
        {icon}
        <span className="text-[10px] md:text-xs">{label}</span>
      </div>
      <div className="text-xs md:text-sm font-medium">{value}</div>
      {sparkline && <div className="flex justify-center mt-1">{sparkline}</div>}
    </div>
  );
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatAppName(name: string): string {
  // Convert kebab-case to Title Case
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
