import { Package, ExternalLink, Play, Square, RotateCw, Trash2, Users } from 'lucide-react';
import type { AppManifest, Deployment } from '../api/client';
import StatusBadge from './StatusBadge';

interface AppCardProps {
  app: AppManifest;
  deployment?: Deployment;
  groupName?: string;
  onInstall?: () => void;
  onStart?: () => void;
  onStop?: () => void;
  onRestart?: () => void;
  onUninstall?: () => void;
  canManage?: boolean;  // Can install/uninstall (admin only)
  canOperate?: boolean; // Can start/stop/restart (admin + operator)
}

const categoryColors: Record<string, string> = {
  bitcoin: 'text-bitcoin',
  lightning: 'text-yellow-400',
  indexer: 'text-blue-400',
  explorer: 'text-purple-400',
  utility: 'text-gray-400',
};

export default function AppCard({
  app,
  deployment,
  groupName,
  onInstall,
  onStart,
  onStop,
  onRestart,
  onUninstall,
  canManage = true,
  canOperate = true,
}: AppCardProps) {
  const isInstalled = !!deployment;
  const isRunning = deployment?.status === 'running';
  const canControl = isInstalled && !['installing', 'configuring', 'uninstalling'].includes(deployment?.status || '');

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-3">
            <div className={`p-2 bg-gray-700 rounded-lg ${categoryColors[app.category] || 'text-gray-400'}`}>
              <Package size={24} />
            </div>
            <div>
              <h3 className="font-medium">{app.displayName}</h3>
              <p className="text-sm text-gray-400">v{app.version}</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            {deployment && <StatusBadge status={deployment.status} size="sm" />}
            {groupName && (
              <span className="flex items-center gap-1 text-xs text-gray-500">
                <Users size={10} />
                {groupName}
              </span>
            )}
          </div>
        </div>

        <p className="text-sm text-gray-400 mb-4 line-clamp-2">{app.description}</p>

        {/* Services provided */}
        {app.provides && app.provides.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-4">
            {app.provides.map((service) => (
              <span
                key={service.name}
                className="text-xs bg-gray-700 px-2 py-0.5 rounded"
              >
                {service.name}
              </span>
            ))}
          </div>
        )}

        {/* Dependencies */}
        {app.requires && app.requires.length > 0 && (
          <div className="text-xs text-gray-500 mb-4">
            Requires: {app.requires.map((r) => r.service).join(', ')}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-4 py-3 bg-gray-750 border-t border-gray-700 flex items-center justify-between">
        {!isInstalled ? (
          canManage && (
            <button
              onClick={onInstall}
              className="px-4 py-1.5 bg-bitcoin hover:bg-bitcoin/90 text-black font-medium rounded text-sm transition-colors"
            >
              Install
            </button>
          )
        ) : (
          <div className="flex items-center gap-2">
            {canControl && canOperate && !isRunning && (
              <button
                onClick={onStart}
                className="p-1.5 hover:bg-gray-700 rounded transition-colors text-green-500"
                title="Start"
              >
                <Play size={18} />
              </button>
            )}
            {canControl && canOperate && isRunning && (
              <button
                onClick={onStop}
                className="p-1.5 hover:bg-gray-700 rounded transition-colors text-yellow-500"
                title="Stop"
              >
                <Square size={18} />
              </button>
            )}
            {canControl && canOperate && isRunning && (
              <button
                onClick={onRestart}
                className="p-1.5 hover:bg-gray-700 rounded transition-colors text-blue-500"
                title="Restart"
              >
                <RotateCw size={18} />
              </button>
            )}
            {canControl && canManage && (
              <button
                onClick={onUninstall}
                className="p-1.5 hover:bg-gray-700 rounded transition-colors text-red-500"
                title="Uninstall"
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>
        )}

        {app.webui?.enabled && isRunning && (
          <a
            href={app.webui.basePath}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Open <ExternalLink size={14} />
          </a>
        )}
      </div>
    </div>
  );
}
