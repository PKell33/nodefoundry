import { memo, useCallback, useMemo } from 'react';
import { Ban, Play, Square, RotateCw, ExternalLink, Link, Settings, FileText, Trash2, Server, Shield } from 'lucide-react';
import type { AppManifest, Deployment, Server as ServerType } from '../api/client';
import AppIcon from './AppIcon';
import StatusBadge from './StatusBadge';

interface AppCardProps {
  app: AppManifest;
  deployments?: Deployment[];
  servers?: ServerType[];
  conflictsWith?: string | null;
  onClick: () => void;
  onStart?: (deploymentId: string) => void;
  onStop?: (deploymentId: string) => void;
  onRestart?: (deploymentId: string) => void;
  onUninstall?: (deploymentId: string) => void;
  onConnectionInfo?: (deploymentId: string) => void;
  onSettings?: (deployment: Deployment) => void;
  onLogs?: (deploymentId: string, serverName: string) => void;
  canManage?: boolean;
  canOperate?: boolean;
}

// Memoized deployment row component to prevent re-renders
interface DeploymentRowProps {
  deployment: Deployment;
  serverName: string;
  app: AppManifest;
  hasServices: boolean;
  hasEditableConfig: boolean;
  canManage: boolean;
  canOperate: boolean;
  onStart?: (deploymentId: string) => void;
  onStop?: (deploymentId: string) => void;
  onRestart?: (deploymentId: string) => void;
  onUninstall?: (deploymentId: string) => void;
  onConnectionInfo?: (deploymentId: string) => void;
  onSettings?: (deployment: Deployment) => void;
  onLogs?: (deploymentId: string, serverName: string) => void;
}

const DeploymentRow = memo(function DeploymentRow({
  deployment,
  serverName,
  app,
  hasServices,
  hasEditableConfig,
  canManage,
  canOperate,
  onStart,
  onStop,
  onRestart,
  onUninstall,
  onConnectionInfo,
  onSettings,
  onLogs,
}: DeploymentRowProps) {
  const isRunning = deployment.status === 'running';
  const canControl = !['installing', 'configuring', 'uninstalling'].includes(deployment.status);

  const handleStart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onStart?.(deployment.id);
  }, [onStart, deployment.id]);

  const handleStop = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onStop?.(deployment.id);
  }, [onStop, deployment.id]);

  const handleRestart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onRestart?.(deployment.id);
  }, [onRestart, deployment.id]);

  const handleWebUI = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const handleConnectionInfo = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onConnectionInfo?.(deployment.id);
  }, [onConnectionInfo, deployment.id]);

  const handleSettings = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSettings?.(deployment);
  }, [onSettings, deployment]);

  const handleLogs = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onLogs?.(deployment.id, serverName);
  }, [onLogs, deployment.id, serverName]);

  const handleUninstall = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onUninstall?.(deployment.id);
  }, [onUninstall, deployment.id]);

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-[var(--border-color)] last:border-b-0"
    >
      {/* Server info */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <Server size={14} className="text-muted flex-shrink-0" />
        <span className="text-sm font-medium">{serverName}</span>
        <StatusBadge status={deployment.status} size="sm" />
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-0.5">
        {/* Start */}
        {canControl && canOperate && !isRunning && (
          <button
            onClick={handleStart}
            title="Start"
            className="p-1.5 rounded hover:bg-green-600/20 text-green-500 transition-colors"
          >
            <Play size={14} />
          </button>
        )}

        {/* Stop - disabled for mandatory system apps */}
        {canControl && canOperate && isRunning && !app.mandatory && (
          <button
            onClick={handleStop}
            title="Stop"
            className="p-1.5 rounded hover:bg-yellow-600/20 text-yellow-500 transition-colors"
          >
            <Square size={14} />
          </button>
        )}

        {/* Restart */}
        {canControl && canOperate && isRunning && (
          <button
            onClick={handleRestart}
            title="Restart"
            className="p-1.5 rounded hover:bg-blue-600/20 text-blue-500 transition-colors"
          >
            <RotateCw size={14} />
          </button>
        )}

        {/* Web UI */}
        {app.webui?.enabled && isRunning && (
          <a
            href={app.webui.basePath}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleWebUI}
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
        {hasEditableConfig && canManage && (
          <button
            onClick={handleSettings}
            title="Settings"
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
          >
            <Settings size={14} />
          </button>
        )}

        {/* Logs */}
        {canOperate && (
          <button
            onClick={handleLogs}
            title="View Logs"
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
          >
            <FileText size={14} />
          </button>
        )}

        {/* Uninstall - disabled for mandatory system apps */}
        {canControl && canManage && !app.mandatory && (
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

const AppCard = memo(function AppCard({
  app,
  deployments = [],
  servers = [],
  conflictsWith,
  onClick,
  onStart,
  onStop,
  onRestart,
  onUninstall,
  onConnectionInfo,
  onSettings,
  onLogs,
  canManage = false,
  canOperate = false,
}: AppCardProps) {
  const isInstalled = deployments.length > 0;
  const isBlocked = !isInstalled && !!conflictsWith;
  const hasServices = !!(app.provides && app.provides.length > 0);
  const hasEditableConfig = useMemo(
    () => app.configSchema?.some(f => !f.generated && !f.inheritFrom) ?? false,
    [app.configSchema]
  );

  const getServerName = useCallback((serverId: string) => {
    const server = servers.find(s => s.id === serverId);
    return server?.name || serverId;
  }, [servers]);

  return (
    <div className={`card ${isBlocked ? 'opacity-60' : ''}`}>
      {/* Header - clickable to open modal */}
      <div
        onClick={onClick}
        className="p-4 cursor-pointer hover:bg-[var(--bg-secondary)] transition-colors rounded-t-xl"
      >
        <div className="flex items-start gap-4">
          {/* Icon */}
          <div className="w-16 h-16 rounded-xl bg-[var(--bg-tertiary)] flex items-center justify-center overflow-hidden flex-shrink-0">
            <AppIcon appName={app.name} size={48} />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-base truncate">{app.displayName}</h3>
                  {app.system && (
                    <span className="flex items-center gap-1 text-xs bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded">
                      <Shield size={10} />
                      System
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted">v{app.version}</p>
              </div>
            </div>

            {/* Description */}
            <p className="text-sm text-muted mt-1 line-clamp-2">
              {app.description}
            </p>
          </div>
        </div>
      </div>

      {/* Conflict warning */}
      {isBlocked && (
        <div className="border-t border-[var(--border-color)] px-4 py-2">
          <div className="flex items-center gap-1 text-xs text-amber-500">
            <Ban size={12} />
            <span>Conflicts with {conflictsWith}</span>
          </div>
        </div>
      )}

      {/* Install hint if not installed and not blocked */}
      {!isInstalled && !isBlocked && (
        <div className="border-t border-[var(--border-color)] px-4 py-2">
          <p className="text-xs text-muted">
            {app.mandatory ? 'Auto-installed on core server' : 'Click to install'}
          </p>
        </div>
      )}

      {/* Server deployments with actions */}
      {isInstalled && (
        <div className="border-t border-[var(--border-color)]">
          {deployments.map((deployment) => (
            <DeploymentRow
              key={deployment.id}
              deployment={deployment}
              serverName={getServerName(deployment.serverId)}
              app={app}
              hasServices={hasServices}
              hasEditableConfig={hasEditableConfig}
              canManage={canManage}
              canOperate={canOperate}
              onStart={onStart}
              onStop={onStop}
              onRestart={onRestart}
              onUninstall={onUninstall}
              onConnectionInfo={onConnectionInfo}
              onSettings={onSettings}
              onLogs={onLogs}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export default AppCard;
