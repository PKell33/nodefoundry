import { Ban } from 'lucide-react';
import type { AppManifest, Deployment } from '../api/client';
import StatusBadge from './StatusBadge';
import AppIcon from './AppIcon';

interface AppCardProps {
  app: AppManifest;
  deployment?: Deployment;
  conflictsWith?: string | null;
  onClick: () => void;
}

export default function AppCard({ app, deployment, conflictsWith, onClick }: AppCardProps) {
  const isInstalled = !!deployment;
  const isRunning = deployment?.status === 'running';
  const isBlocked = !isInstalled && !!conflictsWith;

  return (
    <div
      onClick={onClick}
      className={`rounded-xl p-6 cursor-pointer transition-all group ${isBlocked ? 'opacity-60' : ''}`}
      style={{
        backgroundColor: 'var(--bg-secondary, #24283b)',
        border: isBlocked
          ? '1px solid var(--border-color, #292e42)'
          : '1px solid var(--border-color, #292e42)',
      }}
      onMouseEnter={(e) => {
        if (!isBlocked) {
          e.currentTarget.style.borderColor = 'rgba(122, 162, 247, 0.5)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-color, #292e42)';
      }}
    >
      <div className="flex flex-col items-center text-center">
        {/* Large Icon */}
        <div className="mb-4 relative">
          <div
            className="w-20 h-20 rounded-2xl flex items-center justify-center overflow-hidden group-hover:scale-105 transition-transform"
            style={{ backgroundColor: 'rgba(122, 162, 247, 0.1)' }}
          >
            <AppIcon appName={app.name} size={64} />
          </div>
          {/* Status indicator dot */}
          {isInstalled && (
            <div
              className={`absolute -bottom-1 -right-1 w-5 h-5 rounded-full border-2 ${
                isRunning ? 'bg-green-500' :
                deployment?.status === 'error' ? 'bg-red-500' :
                'bg-yellow-500'
              }`}
              style={{ borderColor: 'var(--bg-secondary, #24283b)' }}
            />
          )}
        </div>

        {/* App Name */}
        <h3 className="font-semibold text-lg mb-1" style={{ color: 'var(--text-primary, #c0caf5)' }}>{app.displayName}</h3>

        {/* Version */}
        <p className="text-sm mb-2" style={{ color: 'var(--text-muted, #565f89)' }}>v{app.version}</p>

        {/* Brief Description - truncated to 2 lines */}
        <p className="text-sm line-clamp-2 mb-3" style={{ color: 'var(--text-muted, #565f89)' }}>
          {app.description}
        </p>

        {/* Status Badge if installed */}
        {isInstalled && (
          <StatusBadge status={deployment.status} size="sm" />
        )}

        {/* Conflict warning */}
        {isBlocked && (
          <div className="flex items-center gap-1 text-xs text-amber-500">
            <Ban size={12} />
            <span>Conflicts with {conflictsWith}</span>
          </div>
        )}

        {/* Install hint if not installed and not blocked */}
        {!isInstalled && !isBlocked && (
          <span className="text-xs" style={{ color: 'var(--text-muted, #565f89)' }}>Click to install</span>
        )}
      </div>
    </div>
  );
}
