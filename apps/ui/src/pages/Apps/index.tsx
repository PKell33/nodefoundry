import { Link } from 'react-router-dom';
import { Package } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

/**
 * App Stores index - Choose which app store to browse
 */
export default function AppsIndex() {
  const { data: umbrelStatus } = useQuery({
    queryKey: ['apps', 'status'],
    queryFn: () => api.getAppSyncStatus(),
  });

  const { data: start9Apps } = useQuery({
    queryKey: ['start9Apps'],
    queryFn: () => api.getStart9Apps(),
  });

  const { data: casaosApps } = useQuery({
    queryKey: ['casaosApps'],
    queryFn: () => api.getCasaOSApps(),
  });

  const { data: runtipiApps } = useQuery({
    queryKey: ['runtipiApps'],
    queryFn: () => api.getRuntipiApps(),
  });

  const start9Count = start9Apps?.apps?.length || 0;
  const casaosCount = casaosApps?.apps?.length || 0;
  const runtipiCount = runtipiApps?.apps?.length || 0;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Umbrel Store */}
        <Link
          to="/apps/umbrel"
          className="card p-6 hover:border-accent transition-colors group"
        >
          <div className="flex items-start gap-4">
            <div className="w-16 h-16 rounded-xl bg-[#5c16c5] flex items-center justify-center">
              <Package size={32} className="text-white" />
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-semibold group-hover:text-accent transition-colors">
                Umbrel
              </h2>
              <p className="text-muted text-sm mt-1">
                Docker-based apps from the Umbrel App Store
              </p>
              <p className="text-sm mt-3">
                <span className="text-accent font-medium">{umbrelStatus?.appCount || 0}</span>
                <span className="text-muted"> apps available</span>
              </p>
            </div>
          </div>
        </Link>

        {/* Start9 Store */}
        <Link
          to="/apps/start9"
          className="card p-6 hover:border-accent transition-colors group"
        >
          <div className="flex items-start gap-4">
            <div className="w-16 h-16 rounded-xl bg-[#1a1a2e] flex items-center justify-center">
              <Package size={32} className="text-[#00d4aa]" />
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-semibold group-hover:text-accent transition-colors">
                Start9
              </h2>
              <p className="text-muted text-sm mt-1">
                Bitcoin-focused apps from Start9 Marketplace
              </p>
              <p className="text-sm mt-3">
                <span className="text-accent font-medium">{start9Count}</span>
                <span className="text-muted"> apps available</span>
              </p>
            </div>
          </div>
        </Link>

        {/* CasaOS Store */}
        <Link
          to="/apps/casaos"
          className="card p-6 hover:border-accent transition-colors group"
        >
          <div className="flex items-start gap-4">
            <div className="w-16 h-16 rounded-xl bg-[#0067e6] flex items-center justify-center">
              <Package size={32} className="text-white" />
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-semibold group-hover:text-accent transition-colors">
                CasaOS
              </h2>
              <p className="text-muted text-sm mt-1">
                Docker apps from CasaOS App Stores
              </p>
              <p className="text-sm mt-3">
                <span className="text-accent font-medium">{casaosCount}</span>
                <span className="text-muted"> apps available</span>
              </p>
            </div>
          </div>
        </Link>

        {/* Runtipi Store */}
        <Link
          to="/apps/runtipi"
          className="card p-6 hover:border-accent transition-colors group"
        >
          <div className="flex items-start gap-4">
            <div className="w-16 h-16 rounded-xl bg-[#e11d48] flex items-center justify-center">
              <Package size={32} className="text-white" />
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-semibold group-hover:text-accent transition-colors">
                Runtipi
              </h2>
              <p className="text-muted text-sm mt-1">
                Self-hosted apps from Runtipi App Store
              </p>
              <p className="text-sm mt-3">
                <span className="text-accent font-medium">{runtipiCount}</span>
                <span className="text-muted"> apps available</span>
              </p>
            </div>
          </div>
        </Link>
    </div>
  );
}
