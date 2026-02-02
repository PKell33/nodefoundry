import { RefreshCw, Settings, Loader2 } from 'lucide-react';

interface AppStoreHeaderProps {
  appCount: number;
  onSync: () => void;
  isSyncing: boolean;
  syncDisabled?: boolean;
  onOpenSettings?: () => void;
}

export function AppStoreHeader({
  appCount,
  onSync,
  isSyncing,
  syncDisabled = false,
  onOpenSettings,
}: AppStoreHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-muted text-sm">
        {appCount} app{appCount !== 1 ? 's' : ''} available
      </p>
      <div className="flex items-center gap-2">
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="btn btn-secondary p-2"
            title="Manage Registries"
          >
            <Settings size={18} />
          </button>
        )}
        <button
          onClick={onSync}
          disabled={isSyncing || syncDisabled}
          className="btn btn-primary inline-flex items-center gap-2"
        >
          {isSyncing ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Syncing...
            </>
          ) : (
            <>
              <RefreshCw size={16} />
              Sync
            </>
          )}
        </button>
      </div>
    </div>
  );
}
