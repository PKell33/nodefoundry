import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Server, Package, Activity, ExternalLink } from 'lucide-react';
import { useServers, useDeployments, useSystemStatus, useApps, useStartDeployment, useStopDeployment, useRestartDeployment, useUninstallDeployment } from '../hooks/useApi';
import { useAuthStore } from '../stores/useAuthStore';
import ServerCard from '../components/ServerCard';
import StatusBadge from '../components/StatusBadge';
import { useMetricsStore } from '../stores/useMetricsStore';
import { ComponentErrorBoundary } from '../components/ComponentErrorBoundary';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { QueryError } from '../components/QueryError';

export default function Dashboard() {
  const { data: servers, isLoading: serversLoading, error: serversError, refetch: refetchServers } = useServers();
  const { data: deployments, isLoading: deploymentsLoading, error: deploymentsError, refetch: refetchDeployments } = useDeployments();
  const { data: apps } = useApps();
  const { data: status } = useSystemStatus();
  const { user } = useAuthStore();

  const startMutation = useStartDeployment();
  const stopMutation = useStopDeployment();
  const restartMutation = useRestartDeployment();
  const uninstallMutation = useUninstallDeployment();

  const canManage = user?.isSystemAdmin ?? false;
  const canOperate = user?.isSystemAdmin || user?.groups?.some(g => g.role === 'admin' || g.role === 'operator') || false;
  const addMetrics = useMetricsStore((state) => state.addMetrics);

  const runningDeployments = deployments?.filter((d) => d.status === 'running') || [];

  const getAppDisplayName = (appName: string) => {
    const app = apps?.find(a => a.name === appName);
    return app?.displayName || appName;
  };

  const getServerName = (serverId: string) => {
    const server = servers?.find(s => s.id === serverId);
    return server?.name || serverId;
  };
  const appsWithWebUI = runningDeployments.filter((d) => {
    // We'd need the manifest to know if it has webui
    // For now, check common apps that have web interfaces
    return ['mock-app', 'grafana', 'portainer', 'adminer', 'pgadmin'].includes(d.appName);
  });

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
          Overview of your deployed applications
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
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 min-[1800px]:grid-cols-3 gap-4">
            {servers?.slice(0, 3).map((server) => {
              const serverDeployments = deployments?.filter((d) => d.serverId === server.id) || [];
              return (
                <ComponentErrorBoundary key={server.id} componentName={`Server: ${server.name}`}>
                  <ServerCard
                    server={server}
                    deployments={serverDeployments}
                    apps={apps}
                    canManage={canManage}
                    canOperate={canOperate}
                    onStartApp={(id) => startMutation.mutate(id)}
                    onStopApp={(id) => stopMutation.mutate(id)}
                    onRestartApp={(id) => restartMutation.mutate(id)}
                    onUninstallApp={(id) => uninstallMutation.mutate(id)}
                  />
                </ComponentErrorBoundary>
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
          <LoadingSpinner message="Loading deployments..." />
        ) : deploymentsError ? (
          <QueryError error={deploymentsError} refetch={refetchDeployments} message="Failed to load deployments" />
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
                    <span className="font-medium">{getAppDisplayName(deployment.appName)}</span>
                    <StatusBadge status={deployment.status} size="sm" />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span>{getServerName(deployment.serverId)}</span>
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
                      <td className="px-4 py-3 font-medium">{getAppDisplayName(deployment.appName)}</td>
                      <td className="px-4 py-3 text-muted">
                        {getServerName(deployment.serverId)}
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

