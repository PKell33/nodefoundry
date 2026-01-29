import { useState } from 'react';
import { ExternalLink, Play, Square, RotateCw, Trash2, Download, Github, GitBranch, Users, Link, Ban } from 'lucide-react';
import type { AppManifest, Deployment } from '../api/client';
import StatusBadge from './StatusBadge';
import AppIcon from './AppIcon';
import Modal from './Modal';
import ConnectionInfoModal from './ConnectionInfoModal';

interface AppDetailModalProps {
  app: AppManifest;
  deployment?: Deployment;
  groupName?: string;
  conflictsWith?: string | null;
  isOpen: boolean;
  onClose: () => void;
  onInstall?: () => void;
  onStart?: () => void;
  onStop?: () => void;
  onRestart?: () => void;
  onUninstall?: () => void;
  canManage?: boolean;
  canOperate?: boolean;
}

export default function AppDetailModal({
  app,
  deployment,
  groupName,
  conflictsWith,
  isOpen,
  onClose,
  onInstall,
  onStart,
  onStop,
  onRestart,
  onUninstall,
  canManage = true,
  canOperate = true,
}: AppDetailModalProps) {
  const [showConnectionInfo, setShowConnectionInfo] = useState(false);

  const isInstalled = !!deployment;
  const isRunning = deployment?.status === 'running';
  const canControl = isInstalled && !['installing', 'configuring', 'uninstalling'].includes(deployment?.status || '');
  const hasServices = app.provides && app.provides.length > 0;
  const isBlocked = !isInstalled && !!conflictsWith;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="" size="lg">
      <div className="space-y-6">
        {/* Header with Icon and Name */}
        <div className="flex items-start gap-6">
          <div className="w-24 h-24 rounded-2xl bg-gray-100 dark:bg-gray-700 flex items-center justify-center overflow-hidden flex-shrink-0">
            <AppIcon appName={app.name} size={80} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold">{app.displayName}</h2>
                <p className="text-gray-500 dark:text-gray-400">v{app.version}</p>
              </div>
              {isInstalled && (
                <StatusBadge status={deployment.status} />
              )}
            </div>
            <p className="text-gray-500 dark:text-gray-400 mt-2">{app.description}</p>
            {groupName && (
              <div className="flex items-center gap-1 mt-2 text-sm text-gray-500">
                <Users size={14} />
                <span>{groupName}</span>
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          {!isInstalled ? (
            isBlocked ? (
              <div className="flex items-center gap-2 px-4 py-2 bg-amber-900/30 border border-amber-700 text-amber-400 rounded-lg">
                <Ban size={18} />
                <span>Conflicts with {conflictsWith}</span>
              </div>
            ) : canManage && (
              <button
                onClick={onInstall}
                className="flex items-center gap-2 px-6 py-2.5 bg-bitcoin hover:bg-bitcoin/90 text-black font-medium rounded-lg transition-colors"
              >
                <Download size={18} />
                Install
              </button>
            )
          ) : (
            <>
              {canControl && canOperate && !isRunning && (
                <button
                  onClick={onStart}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
                >
                  <Play size={18} />
                  Start
                </button>
              )}
              {canControl && canOperate && isRunning && (
                <button
                  onClick={onStop}
                  className="flex items-center gap-2 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition-colors"
                >
                  <Square size={18} />
                  Stop
                </button>
              )}
              {canControl && canOperate && isRunning && (
                <button
                  onClick={onRestart}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                >
                  <RotateCw size={18} />
                  Restart
                </button>
              )}
              {app.webui?.enabled && isRunning && (
                <a
                  href={app.webui.basePath}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-white rounded-lg transition-colors"
                >
                  <ExternalLink size={18} />
                  Open UI
                </a>
              )}
              {isInstalled && hasServices && canManage && (
                <button
                  onClick={() => setShowConnectionInfo(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-white rounded-lg transition-colors"
                >
                  <Link size={18} />
                  Connection Info
                </button>
              )}
              {canControl && canManage && (
                <button
                  onClick={onUninstall}
                  className="flex items-center gap-2 px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-500 rounded-lg transition-colors ml-auto"
                >
                  <Trash2 size={18} />
                  Uninstall
                </button>
              )}
            </>
          )}
        </div>

        {/* Details Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-gray-200 dark:border-gray-700">
          {/* Source */}
          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-3">Source</h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
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
            </div>
          </div>

          {/* Category */}
          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-3">Category</h3>
            <span className="inline-block px-3 py-1 bg-gray-100 dark:bg-gray-700 rounded-full text-sm capitalize">
              {app.category}
            </span>
          </div>

          {/* Services Provided */}
          {app.provides && app.provides.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-3">Services Provided</h3>
              <div className="space-y-2">
                {app.provides.map((service) => (
                  <div key={service.name} className="flex items-center justify-between text-sm bg-gray-100 dark:bg-gray-900 px-3 py-2 rounded-lg">
                    <span className="text-gray-700 dark:text-gray-300">{service.name}</span>
                    <span className="text-gray-500">:{service.port} ({service.protocol})</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Dependencies */}
          {app.requires && app.requires.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-3">Dependencies</h3>
              <div className="space-y-2">
                {app.requires.map((req) => (
                  <div key={req.service} className="flex items-center justify-between text-sm bg-gray-100 dark:bg-gray-900 px-3 py-2 rounded-lg">
                    <span className="text-gray-700 dark:text-gray-300">{req.service}</span>
                    <span className="text-gray-500 text-xs">{req.locality}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Conflicts */}
          {app.conflicts && app.conflicts.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-3">Conflicts With</h3>
              <p className="text-xs text-gray-500 mb-2">Only one of these can be installed at a time</p>
              <div className="flex flex-wrap gap-2">
                {app.conflicts.map((conflict) => (
                  <span key={conflict} className="text-xs bg-red-900/30 text-red-400 px-2 py-1 rounded">
                    {conflict}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Resources */}
          {app.resources && (app.resources.minDisk || app.resources.minMemory) && (
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-3">Requirements</h3>
              <div className="flex gap-4 text-sm text-gray-500 dark:text-gray-400">
                {app.resources.minDisk && <span>Disk: {app.resources.minDisk}</span>}
                {app.resources.minMemory && <span>Memory: {app.resources.minMemory}</span>}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Connection Info Modal */}
      {deployment && (
        <ConnectionInfoModal
          deploymentId={deployment.id}
          isOpen={showConnectionInfo}
          onClose={() => setShowConnectionInfo(false)}
        />
      )}
    </Modal>
  );
}
