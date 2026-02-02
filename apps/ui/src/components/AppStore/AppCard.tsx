import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NormalizedApp, DeploymentStatus, AppStoreSource } from './types';

// Inline SVG fallback icon (can't fail to load)
const FALLBACK_ICON = 'data:image/svg+xml,' + encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
  <rect x="3" y="3" width="18" height="18" rx="3" stroke="#666"/>
  <circle cx="12" cy="10" r="3" stroke="#666"/>
  <path d="M6 21v-1a6 6 0 0 1 12 0v1" stroke="#666"/>
</svg>`);

interface AppCardProps {
  app: NormalizedApp;
  storeType: AppStoreSource;
  deployment?: DeploymentStatus;
}

export function AppCard({
  app,
  storeType,
  deployment,
}: AppCardProps) {
  const navigate = useNavigate();
  const [iconFailed, setIconFailed] = useState(false);
  const isDeployed = !!deployment;
  const category = app.categories?.[0] || app.category;

  const handleClick = () => {
    const registry = app.registry || 'default';
    navigate(`/apps/${storeType}/${registry}/${app.id}`);
  };

  return (
    <div
      className="card p-4 hover:border-accent transition-colors cursor-pointer group"
      onClick={handleClick}
    >
      <div className="flex items-start gap-3">
        <img
          src={iconFailed ? FALLBACK_ICON : app.icon}
          alt={app.name}
          className="w-12 h-12 rounded-lg bg-[var(--bg-secondary)] object-cover"
          onError={() => setIconFailed(true)}
        />
        <div className="flex-1 min-w-0">
          <h3 className="font-medium truncate group-hover:text-accent transition-colors">
            {app.name}
          </h3>
          <p className="text-sm text-muted truncate">{app.tagline}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-muted">{app.version}</span>
            {category && (
              <span className="text-xs px-2 py-0.5 bg-[var(--bg-secondary)] rounded">
                {category}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between">
        {isDeployed ? (
          <span className={`text-xs px-2 py-1 rounded ${
            deployment.status === 'running'
              ? 'bg-green-500/20 text-green-400'
              : deployment.status === 'stopped'
              ? 'bg-yellow-500/20 text-yellow-400'
              : 'bg-gray-500/20 text-gray-400'
          }`}>
            {deployment.status}
          </span>
        ) : (
          <span className="text-xs text-muted">Not installed</span>
        )}
      </div>
    </div>
  );
}
