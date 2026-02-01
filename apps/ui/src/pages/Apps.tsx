import { Package, ExternalLink } from 'lucide-react';

/**
 * Apps page - Umbrel App Store integration (coming soon)
 *
 * This will integrate with the Umbrel app ecosystem to provide
 * 200+ self-hosted applications via Docker containers.
 */
export default function Apps() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold mb-2">Apps</h1>
        <p className="text-muted">Deploy and manage Docker applications</p>
      </div>

      <div className="card p-12 text-center">
        <div className="w-20 h-20 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center mx-auto mb-6">
          <Package size={40} className="text-accent" />
        </div>

        <h2 className="text-xl font-semibold mb-3">Umbrel App Store Coming Soon</h2>

        <p className="text-muted max-w-md mx-auto mb-6">
          OwnPrem will integrate with the Umbrel app ecosystem, giving you access to
          200+ self-hosted applications including Bitcoin nodes, Lightning wallets,
          media servers, and more.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-2xl mx-auto mb-8">
          {['Bitcoin Core', 'Lightning', 'Mempool', 'BTCPay Server', 'Nextcloud', 'Jellyfin', 'Home Assistant', 'Gitea'].map((app) => (
            <div
              key={app}
              className="p-3 rounded-lg bg-[var(--bg-secondary)] text-sm text-[var(--text-secondary)]"
            >
              {app}
            </div>
          ))}
        </div>

        <a
          href="https://github.com/getumbrel/umbrel-apps"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-accent hover:underline"
        >
          Browse Umbrel Apps
          <ExternalLink size={16} />
        </a>
      </div>

      <div className="card p-6">
        <h3 className="font-semibold mb-3">Why Umbrel Apps?</h3>
        <ul className="space-y-2 text-[var(--text-secondary)]">
          <li className="flex items-start gap-2">
            <span className="text-accent">•</span>
            <span><strong>200+ applications</strong> - Bitcoin, media, productivity, and more</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-accent">•</span>
            <span><strong>Docker-based</strong> - Isolated, reproducible deployments</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-accent">•</span>
            <span><strong>Multi-server</strong> - Deploy apps across your infrastructure (OwnPrem exclusive)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-accent">•</span>
            <span><strong>NFS storage</strong> - Use your NAS for app data (OwnPrem exclusive)</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
