import { Link } from 'react-router-dom';
import { ChevronLeft, RefreshCw, Settings, Loader2 } from 'lucide-react';

interface AppStoreHeaderProps {
  title: string;
  appCount: number;
  onSync: () => void;
  isSyncing: boolean;
  syncDisabled?: boolean;
  onOpenSettings?: () => void;
  backLink?: string;
}

export function AppStoreHeader({
  title,
  appCount,
  onSync,
  isSyncing,
  syncDisabled = false,
  onOpenSettings,
  backLink = '/apps',
}: AppStoreHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-4">
        <Link to={backLink} className="btn btn-secondary p-2">
          <ChevronLeft size={20} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-muted text-sm">
            {appCount} app{appCount !== 1 ? 's' : ''} available
          </p>
        </div>
      </div>
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
