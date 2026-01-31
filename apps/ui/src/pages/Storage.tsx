import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  useMounts,
  useServerMounts,
  useServers,
  useCreateMount,
  useDeleteMount,
  useAssignMount,
  useMountStorage,
  useUnmountStorage,
  useDeleteServerMount,
} from '../hooks/useApi';
import { useAuthStore } from '../stores/useAuthStore';
import { showError } from '../lib/toast';
import MountCard from '../components/MountCard';
import Modal from '../components/Modal';
import { ComponentErrorBoundary } from '../components/ComponentErrorBoundary';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { QueryError } from '../components/QueryError';
import type { MountType } from '../api/client';

export default function Storage() {
  const { data: mounts, isLoading: mountsLoading, error: mountsError, refetch: refetchMounts } = useMounts();
  const { data: serverMounts, isLoading: serverMountsLoading, error: serverMountsError, refetch: refetchServerMounts } = useServerMounts();
  const { data: servers } = useServers();
  const { user } = useAuthStore();

  const [addModalOpen, setAddModalOpen] = useState(false);

  const createMountMutation = useCreateMount();
  const deleteMountMutation = useDeleteMount();
  const assignMountMutation = useAssignMount();
  const mountStorageMutation = useMountStorage();
  const unmountStorageMutation = useUnmountStorage();
  const deleteServerMountMutation = useDeleteServerMount();

  const canManage = user?.isSystemAdmin ?? false;
  const isLoading = mountsLoading || serverMountsLoading;
  const error = mountsError || serverMountsError;
  const refetch = () => { refetchMounts(); refetchServerMounts(); };
  const isMutating = createMountMutation.isPending ||
    deleteMountMutation.isPending ||
    assignMountMutation.isPending ||
    mountStorageMutation.isPending ||
    unmountStorageMutation.isPending ||
    deleteServerMountMutation.isPending;

  const handleCreateMount = async (
    name: string,
    mountType: MountType,
    source: string,
    defaultOptions?: string,
    description?: string,
    credentials?: { username: string; password: string; domain?: string }
  ) => {
    try {
      await createMountMutation.mutateAsync({
        name,
        mountType,
        source,
        defaultOptions,
        description,
        credentials,
      });
      setAddModalOpen(false);
    } catch (err) {
      console.error('Failed to create mount:', err);
      showError(err instanceof Error ? err.message : 'Failed to create mount');
    }
  };

  const handleDeleteMount = async (mountId: string) => {
    try {
      await deleteMountMutation.mutateAsync(mountId);
    } catch (err) {
      console.error('Failed to delete mount:', err);
      showError(err instanceof Error ? err.message : 'Failed to delete mount');
    }
  };

  const handleAssignMount = async (
    mountId: string,
    serverId: string,
    mountPoint: string,
    options?: string,
    purpose?: string
  ) => {
    try {
      await assignMountMutation.mutateAsync({
        mountId,
        serverId,
        mountPoint,
        options,
        purpose,
      });
    } catch (err) {
      console.error('Failed to assign mount:', err);
      showError(err instanceof Error ? err.message : 'Failed to assign mount');
    }
  };

  const handleMountStorage = async (serverMountId: string) => {
    try {
      await mountStorageMutation.mutateAsync(serverMountId);
    } catch (err) {
      console.error('Failed to mount storage:', err);
      showError(err instanceof Error ? err.message : 'Failed to mount storage');
    }
  };

  const handleUnmountStorage = async (serverMountId: string) => {
    try {
      await unmountStorageMutation.mutateAsync(serverMountId);
    } catch (err) {
      console.error('Failed to unmount storage:', err);
      showError(err instanceof Error ? err.message : 'Failed to unmount storage');
    }
  };

  const handleDeleteServerMount = async (serverMountId: string) => {
    try {
      await deleteServerMountMutation.mutateAsync(serverMountId);
    } catch (err) {
      console.error('Failed to delete server mount:', err);
      showError(err instanceof Error ? err.message : 'Failed to delete server mount');
    }
  };

  // Group server mounts by mount ID
  const serverMountsByMount = (serverMounts || []).reduce((acc, sm) => {
    if (!acc[sm.mountId]) acc[sm.mountId] = [];
    acc[sm.mountId].push(sm);
    return acc;
  }, {} as Record<string, NonNullable<typeof serverMounts>>);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-2">Storage</h1>
          <p className="text-muted">Manage network storage mounts (NFS/CIFS)</p>
        </div>
        {canManage && (
          <button
            onClick={() => setAddModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/90 text-slate-900 font-medium rounded transition-colors"
          >
            <Plus size={20} />
            Add Mount
          </button>
        )}
      </div>

      {isLoading ? (
        <LoadingSpinner message="Loading storage mounts..." />
      ) : error ? (
        <QueryError error={error} refetch={refetch} message="Failed to load storage mounts" />
      ) : mounts && mounts.length > 0 ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 min-[1800px]:grid-cols-3 gap-4">
          {mounts.map((mount) => (
            <ComponentErrorBoundary key={mount.id} componentName={`Mount: ${mount.name}`}>
              <MountCard
                mount={mount}
                serverMounts={serverMountsByMount[mount.id] || []}
                servers={servers || []}
                canManage={canManage}
                onDelete={() => handleDeleteMount(mount.id)}
                onAssign={(serverId, mountPoint, options, purpose) =>
                  handleAssignMount(mount.id, serverId, mountPoint, options, purpose)
                }
                onMount={handleMountStorage}
                onUnmount={handleUnmountStorage}
                onDeleteServerMount={handleDeleteServerMount}
                isLoading={isMutating}
              />
            </ComponentErrorBoundary>
          ))}
        </div>
      ) : (
        <div className="card p-8 text-center">
          <div className="text-muted mb-4">
            No storage mounts configured yet.
          </div>
          {canManage && (
            <button
              onClick={() => setAddModalOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/90 text-slate-900 font-medium rounded transition-colors"
            >
              <Plus size={20} />
              Add Your First Mount
            </button>
          )}
        </div>
      )}

      {/* Add Mount Modal */}
      {addModalOpen && (
        <Modal
          isOpen={addModalOpen}
          onClose={() => setAddModalOpen(false)}
          title="Add Storage Mount"
          size="lg"
        >
          <AddMountForm
            onSubmit={handleCreateMount}
            isLoading={createMountMutation.isPending}
            onCancel={() => setAddModalOpen(false)}
          />
        </Modal>
      )}
    </div>
  );
}

interface AddMountFormProps {
  onSubmit: (
    name: string,
    mountType: MountType,
    source: string,
    defaultOptions?: string,
    description?: string,
    credentials?: { username: string; password: string; domain?: string }
  ) => void;
  isLoading: boolean;
  onCancel: () => void;
}

function AddMountForm({ onSubmit, isLoading, onCancel }: AddMountFormProps) {
  const [name, setName] = useState('');
  const [mountType, setMountType] = useState<MountType>('nfs');
  const [source, setSource] = useState('');
  const [defaultOptions, setDefaultOptions] = useState('');
  const [description, setDescription] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const credentials = mountType === 'cifs' && username && password
      ? { username, password, domain: domain || undefined }
      : undefined;
    onSubmit(name, mountType, source, defaultOptions || undefined, description || undefined, credentials);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-2">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="app-storage"
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded focus:outline-none focus:border-accent"
          required
          pattern="^[a-zA-Z0-9_-]+$"
          title="Only letters, numbers, underscores, and hyphens"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Type</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="mountType"
              value="nfs"
              checked={mountType === 'nfs'}
              onChange={() => setMountType('nfs')}
              className="text-accent focus:ring-accent"
            />
            <span>NFS</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="mountType"
              value="cifs"
              checked={mountType === 'cifs'}
              onChange={() => setMountType('cifs')}
              className="text-accent focus:ring-accent"
            />
            <span>CIFS (SMB)</span>
          </label>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Source</label>
        <input
          type="text"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder={mountType === 'nfs' ? '192.168.1.10:/volume/data' : '//192.168.1.10/share'}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded focus:outline-none focus:border-accent"
          required
        />
        <p className="text-xs text-muted mt-1">
          {mountType === 'nfs'
            ? 'NFS format: hostname:/path'
            : 'CIFS format: //hostname/share'}
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Default Options (optional)</label>
        <input
          type="text"
          value={defaultOptions}
          onChange={(e) => setDefaultOptions(e.target.value)}
          placeholder={mountType === 'nfs' ? 'vers=4,rw,noatime' : 'uid=1000,gid=1000'}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded focus:outline-none focus:border-accent"
        />
        <p className="text-xs text-muted mt-1">Comma-separated mount options</p>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Description (optional)</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="App data storage on NAS"
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded focus:outline-none focus:border-accent"
        />
      </div>

      {/* CIFS Credentials */}
      {mountType === 'cifs' && (
        <div className="p-4 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <h4 className="text-sm font-medium mb-3">CIFS Credentials</h4>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="smbuser"
                className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded focus:outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded focus:outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Domain (optional)</label>
              <input
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="WORKGROUP"
                className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded focus:outline-none focus:border-accent"
              />
            </div>
          </div>
          <p className="text-xs text-muted mt-3">
            Credentials are stored encrypted and never displayed again.
          </p>
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2 bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] rounded transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading || !name || !source}
          className="flex-1 px-4 py-2 bg-accent hover:bg-accent/90 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:text-gray-500 text-slate-900 font-medium rounded transition-colors"
        >
          {isLoading ? 'Creating...' : 'Create Mount'}
        </button>
      </div>
    </form>
  );
}
