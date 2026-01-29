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
      className={`bg-gray-800 rounded-xl border p-6 cursor-pointer transition-all group ${
        isBlocked
          ? 'border-gray-700 opacity-60'
          : 'border-gray-700 hover:border-gray-600 hover:bg-gray-750'
      }`}
    >
      <div className="flex flex-col items-center text-center">
        {/* Large Icon */}
        <div className="mb-4 relative">
          <div className="w-20 h-20 rounded-2xl bg-gray-700 flex items-center justify-center overflow-hidden group-hover:scale-105 transition-transform">
            <AppIcon appName={app.name} size={64} />
          </div>
          {/* Status indicator dot */}
          {isInstalled && (
            <div className={`absolute -bottom-1 -right-1 w-5 h-5 rounded-full border-2 border-gray-800 ${
              isRunning ? 'bg-green-500' :
              deployment?.status === 'error' ? 'bg-red-500' :
              'bg-yellow-500'
            }`} />
          )}
        </div>

        {/* App Name */}
        <h3 className="font-semibold text-lg mb-1">{app.displayName}</h3>

        {/* Version */}
        <p className="text-sm text-gray-500 mb-2">v{app.version}</p>

        {/* Brief Description - truncated to 2 lines */}
        <p className="text-sm text-gray-400 line-clamp-2 mb-3">
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
          <span className="text-xs text-gray-500">Click to install</span>
        )}
      </div>
    </div>
  );
}
