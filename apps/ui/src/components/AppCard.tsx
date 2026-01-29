import { useState } from 'react';
import { Package, ExternalLink, Play, Square, RotateCw, Trash2, Users, Info, X, Github, Download, GitBranch } from 'lucide-react';
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
  canManage?: boolean;
  canOperate?: boolean;
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
  const [showInfo, setShowInfo] = useState(false);
  const isInstalled = !!deployment;
  const isRunning = deployment?.status === 'running';
  const canControl = isInstalled && !['installing', 'configuring', 'uninstalling'].includes(deployment?.status || '');

  return (
    <>
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
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowInfo(true)}
                  className="p-1 hover:bg-gray-700 rounded transition-colors text-gray-400 hover:text-white"
                  title="App Info"
                >
                  <Info size={16} />
                </button>
                {deployment && <StatusBadge status={deployment.status} size="sm" />}
              </div>
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

      {/* Info Modal */}
      {showInfo && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowInfo(false)}>
          <div
            className="bg-gray-800 rounded-lg border border-gray-700 max-w-lg w-full max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-gray-700 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2 bg-gray-700 rounded-lg ${categoryColors[app.category] || 'text-gray-400'}`}>
                  <Package size={20} />
                </div>
                <div>
                  <h2 className="font-semibold">{app.displayName}</h2>
                  <p className="text-sm text-gray-400">v{app.version}</p>
                </div>
              </div>
              <button
                onClick={() => setShowInfo(false)}
                className="p-1 hover:bg-gray-700 rounded transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Description */}
              <div>
                <h3 className="text-sm font-medium text-gray-300 mb-1">Description</h3>
                <p className="text-sm text-gray-400">{app.description}</p>
              </div>

              {/* Source */}
              <div>
                <h3 className="text-sm font-medium text-gray-300 mb-2">Source</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2 text-gray-400">
                    {app.source.type === 'binary' && <Download size={14} />}
                    {app.source.type === 'git' && <GitBranch size={14} />}
                    <span className="capitalize">{app.source.type}</span>
                  </div>

                  {app.source.githubRepo && (
                    <a
                      href={`https://github.com/${app.source.githubRepo}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      <Github size={14} />
                      {app.source.githubRepo}
                      <ExternalLink size={12} />
                    </a>
                  )}

                  {app.source.downloadUrl && (
                    <div className="text-xs text-gray-500 bg-gray-900 p-2 rounded font-mono break-all">
                      {app.source.downloadUrl}
                    </div>
                  )}

                  {app.source.gitUrl && (
                    <div className="text-xs text-gray-500 bg-gray-900 p-2 rounded font-mono break-all">
                      {app.source.gitUrl}
                    </div>
                  )}
                </div>
              </div>

              {/* Conflicts */}
              {app.conflicts && app.conflicts.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-300 mb-1">Conflicts With</h3>
                  <p className="text-xs text-gray-500 mb-2">Only one of these can be installed at a time</p>
                  <div className="flex flex-wrap gap-1">
                    {app.conflicts.map((conflict) => (
                      <span key={conflict} className="text-xs bg-red-900/30 text-red-400 px-2 py-0.5 rounded">
                        {conflict}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Services Provided */}
              {app.provides && app.provides.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-300 mb-1">Services Provided</h3>
                  <div className="space-y-1">
                    {app.provides.map((service) => (
                      <div key={service.name} className="flex items-center justify-between text-sm bg-gray-900 px-2 py-1 rounded">
                        <span className="text-gray-300">{service.name}</span>
                        <span className="text-gray-500">:{service.port} ({service.protocol})</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Dependencies */}
              {app.requires && app.requires.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-300 mb-1">Dependencies</h3>
                  <div className="space-y-1">
                    {app.requires.map((req) => (
                      <div key={req.service} className="flex items-center justify-between text-sm bg-gray-900 px-2 py-1 rounded">
                        <span className="text-gray-300">{req.service}</span>
                        <span className="text-gray-500">{req.locality}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Resources */}
              {app.resources && (app.resources.minDisk || app.resources.minMemory) && (
                <div>
                  <h3 className="text-sm font-medium text-gray-300 mb-1">Requirements</h3>
                  <div className="flex gap-4 text-sm text-gray-400">
                    {app.resources.minDisk && <span>Disk: {app.resources.minDisk}</span>}
                    {app.resources.minMemory && <span>Memory: {app.resources.minMemory}</span>}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
