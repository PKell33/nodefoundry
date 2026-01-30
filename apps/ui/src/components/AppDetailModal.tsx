import { useState } from 'react';
import { ExternalLink, Play, Square, RotateCw, Trash2, Download, Github, GitBranch, Users, Link, Ban, FileText, Settings } from 'lucide-react';
import type { AppManifest, Deployment } from '../api/client';
import StatusBadge from './StatusBadge';
import AppIcon from './AppIcon';
import Modal from './Modal';
import ConnectionInfoModal from './ConnectionInfoModal';
import LogViewerModal from './LogViewerModal';
import EditConfigModal from './EditConfigModal';

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
  onConfigSaved?: () => void;
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
  onConfigSaved,
  canManage = true,
  canOperate = true,
}: AppDetailModalProps) {
  const [showConnectionInfo, setShowConnectionInfo] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showEditConfig, setShowEditConfig] = useState(false);

  const isInstalled = !!deployment;
  const isRunning = deployment?.status === 'running';
  const canControl = isInstalled && !['installing', 'configuring', 'uninstalling'].includes(deployment?.status || '');
  const hasServices = app.provides && app.provides.length > 0;
  const isBlocked = !isInstalled && !!conflictsWith;
  const hasEditableConfig = app.configSchema?.some(f => !f.generated && !f.inheritFrom) ?? false;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="" size="lg">
      <div className="space-y-6">
        {/* Header with Icon and Name */}
        <div className="flex items-start gap-6">
          <div className="w-24 h-24 rounded-2xl bg-[var(--bg-tertiary)] flex items-center justify-center overflow-hidden flex-shrink-0">
            <AppIcon appName={app.name} size={80} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold">{app.displayName}</h2>
                <p className="text-muted">v{app.version}</p>
              </div>
              {isInstalled && (
                <StatusBadge status={deployment.status} />
              )}
            </div>
            <p className="text-muted mt-2">{app.description}</p>
            {groupName && (
              <div className="flex items-center gap-1 mt-2 text-sm text-gray-500">
                <Users size={14} />
                <span>{groupName}</span>
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-2">
          {!isInstalled ? (
            isBlocked ? (
              <div className="flex items-center gap-2 px-4 py-2 bg-amber-900/30 border border-amber-700 text-amber-400 rounded-lg">
                <Ban size={18} />
                <span>Conflicts with {conflictsWith}</span>
              </div>
            ) : canManage && (
              <button
                onClick={onInstall}
                title="Install"
                className="p-2.5 bg-accent hover:bg-accent/90 text-slate-900 rounded-lg transition-colors"
              >
                <Download size={20} />
              </button>
            )
          ) : (
            <>
              {canControl && canOperate && !isRunning && (
                <button
                  onClick={onStart}
                  title="Start"
                  className="p-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
                >
                  <Play size={20} />
                </button>
              )}
              {canControl && canOperate && isRunning && (
                <button
                  onClick={onStop}
                  title="Stop"
                  className="p-2.5 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition-colors"
                >
                  <Square size={20} />
                </button>
              )}
              {canControl && canOperate && isRunning && (
                <button
                  onClick={onRestart}
                  title="Restart"
                  className="p-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                >
                  <RotateCw size={20} />
                </button>
              )}
              {app.webui?.enabled && isRunning && (
                <a
                  href={app.webui.basePath}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open Web UI"
                  className="p-2.5 rounded-lg transition-colors bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] text-[var(--text-primary)]"
                >
                  <ExternalLink size={20} />
                </a>
              )}
              {isInstalled && hasServices && canManage && (
                <button
                  onClick={() => setShowConnectionInfo(true)}
                  title="Connection Info"
                  className="p-2.5 rounded-lg transition-colors bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] text-[var(--text-primary)]"
                >
                  <Link size={20} />
                </button>
              )}
              {isInstalled && hasEditableConfig && canManage && (
                <button
                  onClick={() => setShowEditConfig(true)}
                  title="Settings"
                  className="p-2.5 rounded-lg transition-colors bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] text-[var(--text-primary)]"
                >
                  <Settings size={20} />
                </button>
              )}
              {isInstalled && canOperate && (
                <button
                  onClick={() => setShowLogs(true)}
                  title="View Logs"
                  className="p-2.5 rounded-lg transition-colors bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] text-[var(--text-primary)]"
                >
                  <FileText size={20} />
                </button>
              )}
              {canControl && canManage && (
                <button
                  onClick={onUninstall}
                  title="Uninstall"
                  className="p-2.5 bg-red-600/20 hover:bg-red-600/30 text-red-500 rounded-lg transition-colors ml-auto"
                >
                  <Trash2 size={20} />
                </button>
              )}
            </>
          )}
        </div>

        {/* Details Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-[var(--border-color)]">
          {/* Source */}
          <div>
            <h3 className="text-sm font-medium text-muted mb-3">Source</h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-muted">
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
            <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Category</h3>
            <span className="inline-block px-3 py-1 bg-[var(--bg-tertiary)] rounded-full text-sm capitalize">
              {app.category}
            </span>
          </div>

          {/* Services Provided */}
          {app.provides && app.provides.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Services Provided</h3>
              <div className="space-y-2">
                {app.provides.map((service) => (
                  <div key={service.name} className="flex items-center justify-between text-sm bg-[var(--bg-primary)] px-3 py-2 rounded-lg">
                    <span className="text-[var(--text-secondary)]">{service.name}</span>
                    <span className="text-muted">:{service.port} ({service.protocol})</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Dependencies */}
          {app.requires && app.requires.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Dependencies</h3>
              <div className="space-y-2">
                {app.requires.map((req) => (
                  <div key={req.service} className="flex items-center justify-between text-sm bg-[var(--bg-primary)] px-3 py-2 rounded-lg">
                    <span className="text-[var(--text-secondary)]">{req.service}</span>
                    <span className="text-muted text-xs">{req.locality}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Conflicts */}
          {app.conflicts && app.conflicts.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Conflicts With</h3>
              <p className="text-xs text-muted mb-2">Only one of these can be installed at a time</p>
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
              <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Requirements</h3>
              <div className="flex gap-4 text-sm text-muted">
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

      {/* Log Viewer Modal */}
      {deployment && (
        <LogViewerModal
          deploymentId={deployment.id}
          appName={app.displayName}
          isOpen={showLogs}
          onClose={() => setShowLogs(false)}
        />
      )}

      {/* Edit Config Modal */}
      {deployment && (
        <EditConfigModal
          deployment={deployment}
          app={app}
          isOpen={showEditConfig}
          onClose={() => setShowEditConfig(false)}
          onSaved={onConfigSaved}
        />
      )}
    </Modal>
  );
}
