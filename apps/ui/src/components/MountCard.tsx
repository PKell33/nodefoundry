import { useState } from 'react';
import { HardDrive, Server, MoreVertical, Trash2, Play, Square, Plus, AlertCircle, CheckCircle, Clock, Loader2 } from 'lucide-react';
import type { Mount, ServerMountWithDetails, Server as ServerType } from '../api/client';
import Modal from './Modal';

interface MountCardProps {
  mount: Mount;
  serverMounts: ServerMountWithDetails[];
  servers: ServerType[];
  canManage: boolean;
  onDelete: () => void;
  onAssign: (serverId: string, mountPoint: string, options?: string, purpose?: string) => void;
  onMount: (serverMountId: string) => void;
  onUnmount: (serverMountId: string) => void;
  onDeleteServerMount: (serverMountId: string) => void;
  isLoading?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function getStatusIcon(status: string) {
  switch (status) {
    case 'mounted':
      return <CheckCircle size={14} className="text-green-500" />;
    case 'mounting':
      return <Loader2 size={14} className="text-blue-500 animate-spin" />;
    case 'error':
      return <AlertCircle size={14} className="text-red-500" />;
    case 'unmounted':
      return <Square size={14} className="text-gray-500" />;
    default:
      return <Clock size={14} className="text-yellow-500" />;
  }
}

export default function MountCard({
  mount,
  serverMounts,
  servers,
  canManage,
  onDelete,
  onAssign,
  onMount,
  onUnmount,
  onDeleteServerMount,
  isLoading = false,
}: MountCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignServerId, setAssignServerId] = useState('');
  const [assignMountPoint, setAssignMountPoint] = useState('/mnt/');
  const [assignOptions, setAssignOptions] = useState('');
  const [assignPurpose, setAssignPurpose] = useState('');

  // Get servers that don't already have this mount assigned
  const assignedServerIds = serverMounts.map(sm => sm.serverId);
  const availableServers = servers.filter(s => !assignedServerIds.includes(s.id));

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete();
      setConfirmDelete(false);
      setShowMenu(false);
    } else {
      setConfirmDelete(true);
    }
  };

  const handleAssignSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (assignServerId && assignMountPoint) {
      onAssign(assignServerId, assignMountPoint, assignOptions || undefined, assignPurpose || undefined);
      setShowAssignModal(false);
      setAssignServerId('');
      setAssignMountPoint('/mnt/');
      setAssignOptions('');
      setAssignPurpose('');
    }
  };

  const hasActiveMounts = serverMounts.some(sm => sm.status === 'mounted' || sm.status === 'mounting');

  return (
    <div className="card p-3 md:p-4">
      <div className="flex items-start justify-between mb-2 md:mb-3">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <div className="p-1.5 md:p-2 rounded-lg flex-shrink-0 bg-[var(--bg-secondary)]">
            <HardDrive size={18} className="text-accent" />
          </div>
          <div className="min-w-0">
            <h3 className="font-medium text-sm md:text-base truncate">{mount.name}</h3>
            <p className="text-xs md:text-sm text-muted truncate">
              {mount.mountType.toUpperCase()} - {mount.source}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 text-xs rounded font-medium ${
            mount.mountType === 'nfs'
              ? 'bg-blue-500/10 text-blue-500'
              : 'bg-purple-500/10 text-purple-500'
          }`}>
            {mount.mountType.toUpperCase()}
          </span>
          {canManage && (
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(!showMenu);
                  setConfirmDelete(false);
                }}
                className="p-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
                aria-label="Mount options menu"
                aria-expanded={showMenu}
                aria-haspopup="menu"
              >
                <MoreVertical size={16} aria-hidden="true" />
              </button>
              {showMenu && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      setConfirmDelete(false);
                    }}
                  />
                  <div className="absolute right-0 top-full mt-1 z-20 py-1 rounded-lg shadow-lg min-w-[180px]
                    bg-[var(--bg-secondary)] border border-[var(--border-color)]">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowMenu(false);
                        setShowAssignModal(true);
                      }}
                      disabled={availableServers.length === 0}
                      className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors
                        text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Server size={14} />
                      Assign to Server
                    </button>
                    <div className="my-1 border-t border-[var(--border-color)]" />
                    <button
                      onClick={handleDelete}
                      disabled={hasActiveMounts}
                      className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors
                        ${hasActiveMounts ? 'text-gray-500 cursor-not-allowed' : 'text-red-500 hover:bg-red-500/10'}`}
                      title={hasActiveMounts ? 'Unmount all servers first' : undefined}
                    >
                      <Trash2 size={14} />
                      {confirmDelete ? 'Confirm Delete' : 'Delete Mount'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {mount.description && (
        <p className="text-xs text-muted mb-3">{mount.description}</p>
      )}

      {mount.defaultOptions && (
        <div className="text-xs text-muted mb-3">
          <span className="font-medium">Options:</span> {mount.defaultOptions}
        </div>
      )}

      <div className="mt-2 md:mt-3 pt-2 md:pt-3 border-t border-[var(--border-color)]">
        {/* Assign to Server Button */}
        {canManage && availableServers.length > 0 && (
          <button
            onClick={() => setShowAssignModal(true)}
            className="w-full mb-2 px-3 py-2 flex items-center justify-center gap-2 text-sm rounded-lg border border-dashed border-[var(--border-color)] hover:border-accent hover:text-accent transition-colors text-muted"
          >
            <Plus size={16} />
            Assign to Server
          </button>
        )}

        {serverMounts.length > 0 ? (
          <div className="space-y-2">
            {serverMounts.map((sm) => (
              <ServerMountItem
                key={sm.id}
                serverMount={sm}
                canManage={canManage}
                onMount={() => onMount(sm.id)}
                onUnmount={() => onUnmount(sm.id)}
                onDelete={() => onDeleteServerMount(sm.id)}
                isLoading={isLoading}
              />
            ))}
          </div>
        ) : (
          <span className="text-xs md:text-sm text-muted">Not assigned to any servers</span>
        )}
      </div>

      {/* Assign to Server Modal */}
      {showAssignModal && (
        <Modal
          isOpen={showAssignModal}
          onClose={() => {
            setShowAssignModal(false);
            setAssignServerId('');
            setAssignMountPoint('/mnt/');
            setAssignOptions('');
            setAssignPurpose('');
          }}
          title="Assign Mount to Server"
          size="md"
        >
          <form onSubmit={handleAssignSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Server</label>
              <select
                value={assignServerId}
                onChange={(e) => setAssignServerId(e.target.value)}
                className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded focus:outline-none focus:border-accent"
                required
              >
                <option value="">Select a server...</option>
                {availableServers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.name} {server.agentStatus !== 'online' ? '(offline)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Mount Point</label>
              <input
                type="text"
                value={assignMountPoint}
                onChange={(e) => setAssignMountPoint(e.target.value)}
                placeholder="/mnt/app-data"
                className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded focus:outline-none focus:border-accent"
                required
                pattern="^/[a-zA-Z0-9/_-]+$"
                title="Must be an absolute path with alphanumeric characters, underscores, and hyphens"
              />
              <p className="text-xs text-muted mt-1">Absolute path where the storage will be mounted</p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Mount Options (optional)</label>
              <input
                type="text"
                value={assignOptions}
                onChange={(e) => setAssignOptions(e.target.value)}
                placeholder="vers=4,rw,noatime"
                className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded focus:outline-none focus:border-accent"
              />
              <p className="text-xs text-muted mt-1">Override default mount options for this server</p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Purpose (optional)</label>
              <input
                type="text"
                value={assignPurpose}
                onChange={(e) => setAssignPurpose(e.target.value)}
                placeholder="app-data"
                className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded focus:outline-none focus:border-accent"
              />
              <p className="text-xs text-muted mt-1">For future app linking (e.g., postgres-data, redis-data)</p>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowAssignModal(false)}
                className="flex-1 px-4 py-2 bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] rounded transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!assignServerId || !assignMountPoint}
                className="flex-1 px-4 py-2 bg-accent hover:bg-accent/90 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:text-gray-500 text-slate-900 font-medium rounded transition-colors"
              >
                Assign
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

interface ServerMountItemProps {
  serverMount: ServerMountWithDetails;
  canManage: boolean;
  onMount: () => void;
  onUnmount: () => void;
  onDelete: () => void;
  isLoading?: boolean;
}

function ServerMountItem({
  serverMount,
  canManage,
  onMount,
  onUnmount,
  onDelete,
  isLoading = false,
}: ServerMountItemProps) {
  const [confirmAction, setConfirmAction] = useState<'unmount' | 'delete' | null>(null);

  const isMounted = serverMount.status === 'mounted';
  const isMounting = serverMount.status === 'mounting';
  const canControl = !isMounting;

  const usagePercent = serverMount.usageBytes && serverMount.totalBytes
    ? Math.round((serverMount.usageBytes / serverMount.totalBytes) * 100)
    : null;

  const handleConfirmAction = () => {
    if (confirmAction === 'unmount') {
      onUnmount();
    } else if (confirmAction === 'delete') {
      onDelete();
    }
    setConfirmAction(null);
  };

  return (
    <div className="p-2 rounded-lg bg-[var(--bg-secondary)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Server size={16} className="text-muted flex-shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{serverMount.serverName}</span>
              {getStatusIcon(serverMount.status)}
            </div>
            <div className="text-xs text-muted truncate">{serverMount.mountPoint}</div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {/* Mount button */}
          {canControl && canManage && !isMounted && (
            <button
              onClick={onMount}
              disabled={isLoading}
              title="Mount"
              className="p-1.5 rounded hover:bg-green-600/20 text-green-500 transition-colors disabled:opacity-50"
            >
              <Play size={14} />
            </button>
          )}

          {/* Unmount button */}
          {canControl && canManage && isMounted && (
            <button
              onClick={() => setConfirmAction('unmount')}
              disabled={isLoading}
              title="Unmount"
              className="p-1.5 rounded hover:bg-yellow-600/20 text-yellow-500 transition-colors disabled:opacity-50"
            >
              <Square size={14} />
            </button>
          )}

          {/* Delete button */}
          {canControl && canManage && !isMounted && (
            <button
              onClick={() => setConfirmAction('delete')}
              disabled={isLoading}
              title="Remove assignment"
              className="p-1.5 rounded hover:bg-red-600/20 text-red-500 transition-colors disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Usage bar */}
      {isMounted && usagePercent !== null && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-xs text-muted mb-1">
            <span>{formatBytes(serverMount.usageBytes!)} / {formatBytes(serverMount.totalBytes!)}</span>
            <span>{usagePercent}%</span>
          </div>
          <div className="h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                usagePercent > 90 ? 'bg-red-500' : usagePercent > 70 ? 'bg-yellow-500' : 'bg-green-500'
              }`}
              style={{ width: `${usagePercent}%` }}
            />
          </div>
        </div>
      )}

      {/* Status message */}
      {serverMount.statusMessage && (
        <div className="mt-2 text-xs text-red-500">{serverMount.statusMessage}</div>
      )}

      {/* Purpose tag */}
      {serverMount.purpose && (
        <div className="mt-2">
          <span className="inline-block px-2 py-0.5 text-xs rounded bg-[var(--bg-tertiary)] text-muted">
            {serverMount.purpose}
          </span>
        </div>
      )}

      {/* Confirm Modal */}
      {confirmAction && (
        <Modal
          isOpen={!!confirmAction}
          onClose={() => setConfirmAction(null)}
          title={confirmAction === 'unmount' ? 'Unmount Storage?' : 'Remove Assignment?'}
          size="sm"
        >
          <div className="space-y-4">
            <p className="text-[var(--text-secondary)]">
              {confirmAction === 'unmount'
                ? `This will unmount the storage from ${serverMount.serverName}. Any apps using this storage should be stopped first.`
                : `This will remove the mount assignment from ${serverMount.serverName}. The mount must be unmounted first.`
              }
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
                className={`flex-1 px-4 py-2 text-white rounded transition-colors ${
                  confirmAction === 'unmount' ? 'bg-yellow-600 hover:bg-yellow-700' : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {confirmAction === 'unmount' ? 'Unmount' : 'Remove'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
