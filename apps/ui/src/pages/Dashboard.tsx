import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Server, Package, HardDrive } from 'lucide-react';
import { useServers, useSystemStatus } from '../hooks/useApi';
import { useMetricsStore } from '../stores/useMetricsStore';
import { ComponentErrorBoundary } from '../components/ComponentErrorBoundary';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { QueryError } from '../components/QueryError';
import { Sparkline } from '../components/MetricsChart';

export default function Dashboard() {
  const { data: servers, isLoading: serversLoading, error: serversError, refetch: refetchServers } = useServers();
  const { data: status } = useSystemStatus();
  const addMetrics = useMetricsStore((state) => state.addMetrics);

  // Seed metrics from server data on load
  useEffect(() => {
    if (servers) {
      servers.forEach((server) => {
        if (server.metrics && server.agentStatus === 'online') {
          addMetrics(server.id, server.metrics);
        }
      });
    }
  }, [servers, addMetrics]);

  return (
    <div className="space-y-6 md:space-y-8">
      <div>
        <h1 className="text-xl md:text-2xl font-bold mb-1 md:mb-2">Dashboard</h1>
        <p className="text-sm md:text-base text-muted">
          Overview of your infrastructure
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 md:gap-4">
        <StatCard
          icon={<Server className="text-accent" size={20} />}
          label="Servers"
          value={status?.servers.online || 0}
          subtext={`of ${status?.servers.total || 0} online`}
        />
        <StatCard
          icon={<Package className="text-green-500" size={20} />}
          label="Apps"
          value="—"
          subtext="Coming soon"
        />
        <StatCard
          icon={<HardDrive className="text-blue-500" size={20} />}
          label="Status"
          value={status?.status === 'ok' ? 'OK' : '!'}
          subtext={status?.status === 'ok' ? 'Healthy' : 'Issues'}
        />
      </div>

      {/* Servers */}
      <section>
        <div className="flex items-center justify-between mb-3 md:mb-4">
          <h2 className="text-base md:text-lg font-semibold">Servers</h2>
          <Link
            to="/servers"
            className="text-sm text-muted hover:text-accent"
          >
            View all
          </Link>
        </div>

        {serversLoading ? (
          <LoadingSpinner message="Loading servers..." />
        ) : serversError ? (
          <QueryError error={serversError} refetch={refetchServers} message="Failed to load servers" />
        ) : servers?.length === 0 ? (
          <div className="card p-6 md:p-8 text-center">
            <Server size={40} className="mx-auto mb-4 text-gray-400 dark:text-gray-600" />
            <p className="text-muted mb-4">No servers connected yet</p>
            <Link
              to="/servers"
              className="inline-flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/90 text-slate-900 font-medium rounded transition-colors text-sm"
            >
              Add Server
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 min-[1800px]:grid-cols-3 gap-4">
            {servers?.slice(0, 6).map((server) => (
              <ComponentErrorBoundary key={server.id} componentName={`Server: ${server.name}`}>
                <div className="card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Server size={18} className="text-accent" />
                      <span className="font-medium">{server.name}</span>
                    </div>
                    <span className={`text-xs px-2 py-1 rounded ${
                      server.agentStatus === 'online'
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-red-500/20 text-red-400'
                    }`}>
                      {server.agentStatus}
                    </span>
                  </div>

                  {server.agentStatus === 'online' && server.metrics && (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-muted">CPU</span>
                          <span className="text-xs font-medium">{server.metrics.cpuPercent?.toFixed(0)}%</span>
                        </div>
                        <Sparkline serverId={server.id} metric="cpu" height={24} width={90} />
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-muted">Memory</span>
                          <span className="text-xs font-medium">
                            {server.metrics.memoryTotal > 0
                              ? ((server.metrics.memoryUsed / server.metrics.memoryTotal) * 100).toFixed(0)
                              : 0}%
                          </span>
                        </div>
                        <Sparkline serverId={server.id} metric="memory" height={24} width={90} />
                      </div>
                    </div>
                  )}

                  {server.agentStatus !== 'online' && (
                    <p className="text-sm text-muted">Agent offline</p>
                  )}
                </div>
              </ComponentErrorBoundary>
            ))}
          </div>
        )}
      </section>

      {/* Apps placeholder */}
      <section>
        <div className="flex items-center justify-between mb-3 md:mb-4">
          <h2 className="text-base md:text-lg font-semibold">Apps</h2>
          <Link
            to="/apps"
            className="text-sm text-muted hover:text-accent"
          >
            Browse apps
          </Link>
        </div>

        <div className="card p-6 md:p-8 text-center">
          <Package size={40} className="mx-auto mb-4 text-gray-400 dark:text-gray-600" />
          <p className="text-muted mb-2">Umbrel App Store integration coming soon</p>
          <p className="text-sm text-muted">200+ self-hosted apps via Docker</p>
        </div>
      </section>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  subtext,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subtext: string;
}) {
  return (
    <div className="card p-3 md:p-4">
      <div className="flex items-center gap-2 md:gap-3 mb-1 md:mb-2">
        {icon}
        <span className="text-xs md:text-sm text-muted">{label}</span>
      </div>
      <div className="text-xl md:text-2xl font-bold">{value}</div>
      <div className="text-xs md:text-sm text-muted">{subtext}</div>
    </div>
  );
}
