import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Server, Package, Activity, ExternalLink, Cpu, MemoryStick, HardDrive } from 'lucide-react';
import { useServers, useDeployments, useSystemStatus } from '../hooks/useApi';
import ServerCard from '../components/ServerCard';
import StatusBadge from '../components/StatusBadge';
import { AggregatedMetricsChart } from '../components/MetricsChart';
import { useMetricsStore } from '../stores/useMetricsStore';

export default function Dashboard() {
  const { data: servers, isLoading: serversLoading } = useServers();
  const { data: deployments, isLoading: deploymentsLoading } = useDeployments();
  const { data: status } = useSystemStatus();
  const addMetrics = useMetricsStore((state) => state.addMetrics);

  const runningDeployments = deployments?.filter((d) => d.status === 'running') || [];
  const appsWithWebUI = runningDeployments.filter((d) => {
    // We'd need the manifest to know if it has webui
    // For now, check common apps
    return ['mempool', 'rtl', 'thunderhub', 'mock-app'].includes(d.appName);
  });

  const onlineServers = servers?.filter((s) => s.agentStatus === 'online') || [];
  const serverIds = onlineServers.map((s) => s.id);

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
          Overview of your Bitcoin infrastructure
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 md:gap-4">
        <StatCard
          icon={<Server className="text-accent" size={20} />}
          label="Servers"
          value={status?.servers.online || 0}
          subtext={`of ${status?.servers.total || 0}`}
        />
        <StatCard
          icon={<Package className="text-green-500" size={20} />}
          label="Running"
          value={status?.deployments.running || 0}
          subtext={`of ${status?.deployments.total || 0}`}
        />
        <StatCard
          icon={<Activity className="text-blue-500" size={20} />}
          label="Status"
          value={status?.status === 'ok' ? 'OK' : '!'}
          subtext={status?.status === 'ok' ? 'Healthy' : 'Issues'}
        />
      </div>

      {/* Resource Usage Charts */}
      {serverIds.length > 0 && (
        <section>
          <h2 className="text-base md:text-lg font-semibold mb-3 md:mb-4">Resource Usage</h2>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <ChartCard
              icon={<Cpu size={16} className="text-amber-500" />}
              title="CPU Usage"
              serverIds={serverIds}
              metric="cpu"
            />
            <ChartCard
              icon={<MemoryStick size={16} className="text-blue-500" />}
              title="Memory Usage"
              serverIds={serverIds}
              metric="memory"
            />
            <ChartCard
              icon={<HardDrive size={16} className="text-emerald-500" />}
              title="Disk Usage"
              serverIds={serverIds}
              metric="disk"
            />
          </div>
        </section>
      )}

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
          <div className="text-muted">Loading...</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
            {servers?.slice(0, 3).map((server) => {
              const serverDeployments = deployments?.filter((d) => d.serverId === server.id) || [];
              return (
                <ServerCard
                  key={server.id}
                  server={server}
                  deploymentCount={serverDeployments.length}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Apps with Web UI */}
      {appsWithWebUI.length > 0 && (
        <section>
          <h2 className="text-base md:text-lg font-semibold mb-3 md:mb-4">Apps with Web UI</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
            {appsWithWebUI.map((deployment) => (
              <a
                key={deployment.id}
                href={`/apps/${deployment.appName}`}
                target="_blank"
                rel="noopener noreferrer"
                className="card card-hover p-3 md:p-4"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium capitalize text-sm md:text-base truncate">
                    {deployment.appName}
                  </span>
                  <ExternalLink size={14} className="text-muted flex-shrink-0" />
                </div>
                <div className="text-xs md:text-sm text-muted truncate">
                  {deployment.serverId}
                </div>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Recent Deployments */}
      <section>
        <div className="flex items-center justify-between mb-3 md:mb-4">
          <h2 className="text-base md:text-lg font-semibold">All Deployments</h2>
          <Link
            to="/apps"
            className="text-sm text-muted hover:text-accent"
          >
            Manage apps
          </Link>
        </div>

        {deploymentsLoading ? (
          <div className="text-muted">Loading...</div>
        ) : deployments?.length === 0 ? (
          <div className="card p-6 md:p-8 text-center">
            <Package size={40} className="mx-auto mb-4 text-gray-400 dark:text-gray-600" />
            <p className="text-muted mb-4">No apps deployed yet</p>
            <Link
              to="/apps"
              className="inline-flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/90 text-slate-900 font-medium rounded transition-colors text-sm"
            >
              Browse Apps
            </Link>
          </div>
        ) : (
          <div className="card overflow-hidden">
            {/* Mobile: Card layout */}
            <div className="md:hidden divide-y divide-[var(--border-color)]">
              {deployments?.map((deployment) => (
                <div key={deployment.id} className="p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium">{deployment.appName}</span>
                    <StatusBadge status={deployment.status} size="sm" />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span>{deployment.serverId}</span>
                    <span>v{deployment.version}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop: Table layout */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="table-header border-b border-[var(--border-color)]">
                    <th className="px-4 py-3">App</th>
                    <th className="px-4 py-3">Server</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Version</th>
                  </tr>
                </thead>
                <tbody>
                  {deployments?.map((deployment) => (
                    <tr key={deployment.id} className="table-row last:border-0">
                      <td className="px-4 py-3 font-medium">{deployment.appName}</td>
                      <td className="px-4 py-3 text-muted">
                        {deployment.serverId}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={deployment.status} size="sm" />
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {deployment.version}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
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

function ChartCard({
  icon,
  title,
  serverIds,
  metric,
}: {
  icon: React.ReactNode;
  title: string;
  serverIds: string[];
  metric: 'cpu' | 'memory' | 'disk';
}) {
  return (
    <div className="card p-3 md:p-4">
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <span className="text-sm font-medium">{title}</span>
      </div>
      <AggregatedMetricsChart serverIds={serverIds} metric={metric} height={120} />
    </div>
  );
}
