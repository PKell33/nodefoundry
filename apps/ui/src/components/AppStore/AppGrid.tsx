import { Loader2, Package, RefreshCw } from 'lucide-react';
import { AppCard } from './AppCard';
import type { NormalizedApp, DeploymentStatus } from './types';

interface AppGridProps {
  apps: NormalizedApp[];
  deployments: DeploymentStatus[];
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  onViewDetails: (app: NormalizedApp) => void;
  onInstall: (app: NormalizedApp) => void;
  // For empty state
  hasFilters: boolean;
  onSync?: () => void;
  isSyncing?: boolean;
  emptyMessage?: string;
}

export function AppGrid({
  apps,
  deployments,
  isLoading,
  error,
  onRetry,
  onViewDetails,
  onInstall,
  hasFilters,
  onSync,
  isSyncing,
  emptyMessage = 'Click Sync to fetch apps from the registry',
}: AppGridProps) {
  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={32} className="animate-spin text-accent" />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="card p-6 text-center">
        <p className="text-red-400 mb-4">Failed to load apps</p>
        <button onClick={onRetry} className="btn btn-secondary">
          Try Again
        </button>
      </div>
    );
  }

  // Empty state
  if (apps.length === 0) {
    return (
      <div className="card p-12 text-center">
        <Package size={48} className="mx-auto text-muted mb-4" />
        <h3 className="text-lg font-medium mb-2">No apps found</h3>
        <p className="text-muted mb-4">
          {hasFilters
            ? 'Try adjusting your search or filter'
            : emptyMessage}
        </p>
        {!hasFilters && onSync && (
          <button
            onClick={onSync}
            disabled={isSyncing}
            className="btn btn-primary inline-flex items-center gap-2"
          >
            {isSyncing ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <RefreshCw size={16} />
            )}
            Sync Apps
          </button>
        )}
      </div>
    );
  }

  // App grid
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {apps.map(app => {
        const deployment = deployments.find(d => d.appId === app.id);
        return (
          <AppCard
            key={`${app.registry || app.source}-${app.id}`}
            app={app}
            deployment={deployment}
            onViewDetails={onViewDetails}
            onInstall={onInstall}
          />
        );
      })}
    </div>
  );
}
