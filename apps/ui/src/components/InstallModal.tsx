import { useState } from 'react';
import { Server as ServerIcon, Loader2, AlertCircle } from 'lucide-react';
import Modal from './Modal';
import type { Server } from '../api/client';

/** Minimal app interface for install modal */
export interface InstallableApp {
  name: string;
  icon: string;
  tagline?: string;
  version: string;
  developer?: string;
  dependencies?: string[];
}

interface InstallModalProps {
  app: InstallableApp;
  servers: Server[];
  onInstall: (serverId: string) => void;
  onClose: () => void;
  isInstalling: boolean;
}

/**
 * Modal for selecting a server to install an app on
 */
export function InstallModal({
  app,
  servers,
  onInstall,
  onClose,
  isInstalling,
}: InstallModalProps) {
  const [selectedServer, setSelectedServer] = useState<string>(
    servers.length > 0 ? servers[0].id : ''
  );

  const handleInstall = () => {
    if (selectedServer) {
      onInstall(selectedServer);
    }
  };

  return (
    <Modal isOpen={true} onClose={onClose} title={`Install ${app.name}`} size="md">
      <div className="space-y-6">
        {/* App info */}
        <div className="flex items-start gap-4">
          <img
            src={app.icon}
            alt={app.name}
            className="w-16 h-16 rounded-lg bg-[var(--bg-tertiary)]"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
          <div>
            <h3 className="text-lg font-semibold">{app.name}</h3>
            {app.tagline && <p className="text-sm text-muted">{app.tagline}</p>}
            <p className="text-xs text-muted mt-1">Version {app.version}{app.developer && ` by ${app.developer}`}</p>
          </div>
        </div>

        {/* Server selection */}
        <div>
          <label className="block text-sm font-medium mb-2">
            Select Server
          </label>

          {servers.length === 0 ? (
            <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 flex items-start gap-3">
              <AlertCircle size={20} className="text-yellow-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-yellow-500 font-medium">No servers available</p>
                <p className="text-sm text-muted mt-1">
                  Make sure at least one server is online before installing apps.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {servers.map((server) => (
                <label
                  key={server.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    selectedServer === server.id
                      ? 'border-accent bg-accent/10'
                      : 'border-[var(--border-primary)] hover:border-accent/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="server"
                    value={server.id}
                    checked={selectedServer === server.id}
                    onChange={(e) => setSelectedServer(e.target.value)}
                    className="sr-only"
                  />
                  <ServerIcon size={20} className={selectedServer === server.id ? 'text-accent' : 'text-muted'} />
                  <div className="flex-1">
                    <span className="font-medium">{server.name}</span>
                    {server.isCore && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 bg-accent/20 text-accent rounded">
                        Core
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-green-500">Online</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Dependencies warning */}
        {app.dependencies && app.dependencies.length > 0 && (
          <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/30">
            <p className="text-sm text-blue-400">
              <strong>Dependencies:</strong> This app depends on {app.dependencies.join(', ')}.
              Make sure these apps are installed first.
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-primary)]">
          <button
            type="button"
            onClick={onClose}
            disabled={isInstalling}
            className="btn btn-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleInstall}
            disabled={isInstalling || servers.length === 0}
            className="btn btn-primary inline-flex items-center gap-2"
          >
            {isInstalling ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Installing...
              </>
            ) : (
              'Install'
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
