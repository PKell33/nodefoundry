import { useState, useEffect } from 'react';
import { api, HAConfig, CaddyInstance, SyncResult } from '../api/client';
import { Network, Server, Crown, RefreshCw, Loader2, AlertCircle, CheckCircle, Settings, ChevronUp, ChevronDown } from 'lucide-react';
import Modal from './Modal';

interface HAConfigResponse {
  enabled: boolean;
  configured?: boolean;
  id?: string;
  vipAddress?: string;
  vipInterface?: string;
  vrrpRouterId?: number;
  createdAt?: string;
  updatedAt?: string;
}

export default function HAConfiguration() {
  const [config, setConfig] = useState<HAConfigResponse | null>(null);
  const [instances, setInstances] = useState<CaddyInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      setLoading(true);
      setError(null);
      const [configData, instancesData] = await Promise.all([
        api.getHAConfig(),
        api.getCaddyInstances(),
      ]);
      setConfig(configData as HAConfigResponse);
      setInstances(instancesData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load HA configuration');
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleEnabled() {
    if (!config || !config.id) return;
    try {
      const newEnabled = !config.enabled;
      await api.setHAEnabled(newEnabled);
      setConfig({ ...config, enabled: newEnabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle HA');
    }
  }

  async function handleSync() {
    try {
      setSyncing(true);
      setSyncResult(null);
      const result = await api.syncKeepalived();
      setSyncResult(result);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync');
    } finally {
      setSyncing(false);
    }
  }

  async function handlePromote(instanceId: string) {
    try {
      await api.promoteCaddyInstance(instanceId);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to promote instance');
    }
  }

  async function handlePriorityChange(instanceId: string, delta: number) {
    const instance = instances.find(i => i.id === instanceId);
    if (!instance) return;
    const newPriority = Math.max(1, Math.min(254, instance.vrrpPriority + delta));
    try {
      await api.setCaddyInstancePriority(instanceId, newPriority);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update priority');
    }
  }

  if (loading) {
    return (
      <section>
        <h2 className="text-lg font-semibold mb-4">High Availability</h2>
        <div className="card p-4 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-muted" />
        </div>
      </section>
    );
  }

  const isConfigured = config && 'id' in config && config.id;

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">High Availability</h2>
        <div className="flex gap-2">
          {isConfigured && instances.length >= 2 && (
            <button
              onClick={handleSync}
              disabled={syncing}
              className="btn btn-secondary btn-sm flex items-center gap-2"
            >
              {syncing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              Sync
            </button>
          )}
          <button
            onClick={() => setShowConfigModal(true)}
            className="btn btn-secondary btn-sm flex items-center gap-2"
          >
            <Settings className="w-4 h-4" />
            Configure
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4 flex items-center gap-2 text-red-400">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {syncResult && (
        <div className={`border rounded-lg p-3 mb-4 flex items-center gap-2 ${
          syncResult.success ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400'
        }`}>
          {syncResult.success ? (
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
          )}
          <span className="text-sm">
            Sync completed: {syncResult.results.filter(r => r.success).length}/{syncResult.results.length} instances updated
          </span>
        </div>
      )}

      <div className="card p-4 space-y-4">
        {/* VIP Configuration */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Network className="w-5 h-5 text-accent" />
            <div>
              <div className="font-medium">Virtual IP Address</div>
              <div className="text-sm text-muted">
                {isConfigured ? config.vipAddress : 'Not configured'}
              </div>
            </div>
          </div>
          {isConfigured && (
            <button
              onClick={handleToggleEnabled}
              className={`px-3 py-1 rounded text-sm font-medium ${
                config.enabled
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-gray-500/20 text-gray-400'
              }`}
            >
              {config.enabled ? 'Enabled' : 'Disabled'}
            </button>
          )}
        </div>

        {isConfigured && (
          <div className="text-sm text-muted space-y-1">
            <div>Interface: {config.vipInterface}</div>
            <div>VRRP Router ID: {config.vrrpRouterId}</div>
          </div>
        )}

        {/* Caddy Instances */}
        {instances.length > 0 && (
          <div className="border-t border-border pt-4">
            <div className="text-sm font-medium mb-3">Caddy Instances</div>
            <div className="space-y-2">
              {instances.map(instance => (
                <div
                  key={instance.id}
                  className="flex items-center justify-between p-3 bg-secondary/50 rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <Server className="w-4 h-4 text-muted" />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{instance.serverName}</span>
                        {instance.isPrimary && (
                          <span className="flex items-center gap-1 text-xs bg-accent/20 text-accent px-2 py-0.5 rounded">
                            <Crown className="w-3 h-3" />
                            Primary
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted">
                        Priority: {instance.vrrpPriority} | Status: {instance.status}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex flex-col">
                      <button
                        onClick={() => handlePriorityChange(instance.id, 10)}
                        className="p-0.5 hover:bg-secondary rounded"
                        title="Increase priority"
                      >
                        <ChevronUp className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => handlePriorityChange(instance.id, -10)}
                        className="p-0.5 hover:bg-secondary rounded"
                        title="Decrease priority"
                      >
                        <ChevronDown className="w-3 h-3" />
                      </button>
                    </div>
                    {!instance.isPrimary && (
                      <button
                        onClick={() => handlePromote(instance.id)}
                        className="text-xs text-accent hover:underline"
                      >
                        Promote
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {instances.length === 0 && (
          <div className="text-sm text-muted text-center py-4">
            No Caddy instances registered. Deploy ownprem-caddy to enable HA.
          </div>
        )}

        {instances.length === 1 && (
          <div className="text-sm text-yellow-400 bg-yellow-500/10 rounded p-2 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            Deploy a second Caddy instance for high availability
          </div>
        )}
      </div>

      {/* Configuration Modal */}
      {showConfigModal && (
        <ConfigureHAModal
          isOpen={showConfigModal}
          onClose={() => setShowConfigModal(false)}
          currentConfig={isConfigured ? config as HAConfig : null}
          onSave={() => {
            setShowConfigModal(false);
            loadData();
          }}
        />
      )}
    </section>
  );
}

interface ConfigureHAModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentConfig: HAConfig | null;
  onSave: () => void;
}

function ConfigureHAModal({ isOpen, onClose, currentConfig, onSave }: ConfigureHAModalProps) {
  const [vipAddress, setVipAddress] = useState(currentConfig?.vipAddress || '');
  const [vipInterface, setVipInterface] = useState(currentConfig?.vipInterface || 'eth0');
  const [vrrpRouterId, setVrrpRouterId] = useState(currentConfig?.vrrpRouterId || 51);
  const [vrrpAuthPass, setVrrpAuthPass] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (currentConfig) {
      setVipAddress(currentConfig.vipAddress);
      setVipInterface(currentConfig.vipInterface);
      setVrrpRouterId(currentConfig.vrrpRouterId);
    }
  }, [currentConfig]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      setSaving(true);
      setError(null);
      await api.configureHA({
        vipAddress,
        vipInterface,
        vrrpRouterId,
        vrrpAuthPass: vrrpAuthPass || undefined,
      });
      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Configure High Availability">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-2 text-red-400">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1">Virtual IP Address *</label>
          <input
            type="text"
            value={vipAddress}
            onChange={e => setVipAddress(e.target.value)}
            className="input w-full"
            placeholder="192.168.1.100"
            required
          />
          <p className="text-xs text-muted mt-1">
            Shared IP address that will float between Caddy instances
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Network Interface</label>
          <input
            type="text"
            value={vipInterface}
            onChange={e => setVipInterface(e.target.value)}
            className="input w-full"
            placeholder="eth0"
          />
          <p className="text-xs text-muted mt-1">
            Network interface for the VIP (e.g., eth0, ens192)
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">VRRP Router ID</label>
          <input
            type="number"
            value={vrrpRouterId}
            onChange={e => setVrrpRouterId(parseInt(e.target.value) || 51)}
            className="input w-full"
            min={1}
            max={255}
          />
          <p className="text-xs text-muted mt-1">
            Unique identifier for this VRRP group (1-255)
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">VRRP Authentication Password</label>
          <input
            type="password"
            value={vrrpAuthPass}
            onChange={e => setVrrpAuthPass(e.target.value)}
            className="input w-full"
            placeholder={currentConfig ? '(leave empty to keep current)' : '(optional)'}
          />
          <p className="text-xs text-muted mt-1">
            Password for VRRP authentication between instances
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={saving || !vipAddress} className="btn btn-primary">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
