import { Link } from 'react-router-dom';
import { Package, Loader2, Settings } from 'lucide-react';
import type { Registry } from './types';

interface RegistryListProps {
  storeType: string;
  registries: Registry[];
  isLoading: boolean;
  onOpenSettings: () => void;
}

/**
 * Grid of registry cards for a store.
 * Shown when no registry is selected.
 */
export function RegistryList({
  storeType,
  registries,
  isLoading,
  onOpenSettings,
}: RegistryListProps) {
  const enabledRegistries = registries.filter(r => r.enabled);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={32} className="animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-end">
        <button
          onClick={onOpenSettings}
          className="btn btn-secondary inline-flex items-center gap-2"
        >
          <Settings size={16} />
          Manage Registries
        </button>
      </div>

      {/* Registry cards */}
      {enabledRegistries.length === 0 ? (
        <div className="card p-12 text-center">
          <Package size={48} className="mx-auto text-muted mb-4" />
          <h3 className="text-lg font-medium mb-2">No registries enabled</h3>
          <p className="text-muted mb-4">
            Add or enable a registry to browse apps
          </p>
          <button
            onClick={onOpenSettings}
            className="btn btn-primary"
          >
            Manage Registries
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {enabledRegistries.map((registry) => (
            <Link
              key={registry.id}
              to={`/apps/${storeType}/${registry.id}`}
              className="card p-6 hover:border-accent transition-colors group"
            >
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-lg bg-accent/20 flex items-center justify-center">
                  <Package size={24} className="text-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold group-hover:text-accent transition-colors truncate">
                    {registry.name}
                  </h3>
                  <p className="text-sm text-muted truncate mt-1">
                    {registry.url}
                  </p>
                  {registry.lastSync && (
                    <p className="text-xs text-muted mt-2">
                      Last synced: {new Date(registry.lastSync).toLocaleDateString()}
                    </p>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
