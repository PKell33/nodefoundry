import { useState, useEffect } from 'react';
import { Copy, Check, Eye, EyeOff, Loader2, Globe, Server, Key, QrCode } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import Modal from './Modal';
import { api, ConnectionInfo, ServiceConnectionInfo } from '../api/client';

interface ConnectionInfoModalProps {
  deploymentId: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function ConnectionInfoModal({ deploymentId, isOpen, onClose }: ConnectionInfoModalProps) {
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [showQR, setShowQR] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && deploymentId) {
      setLoading(true);
      setError(null);
      api.getConnectionInfo(deploymentId)
        .then(setConnectionInfo)
        .catch(err => setError(err.message || 'Failed to load connection info'))
        .finally(() => setLoading(false));
    }
  }, [isOpen, deploymentId]);

  const copyToClipboard = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const toggleSecret = (key: string) => {
    setShowSecrets(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const buildConnectionUrl = (service: ServiceConnectionInfo, mode: 'proxy' | 'direct' | 'tor' = 'proxy') => {
    let host: string;
    let port: number;

    if (mode === 'tor' && service.torAddress) {
      host = service.torAddress;
      port = service.directPort;
    } else if (mode === 'direct') {
      host = service.directHost;
      port = service.directPort;
    } else {
      // Proxy mode
      host = service.host;
      port = service.port || service.directPort;
    }

    // Build URL based on protocol
    if (service.protocol === 'http') {
      const creds = service.credentials;
      const scheme = mode === 'proxy' ? 'https' : 'http';

      // For HTTP path-based routing through Caddy
      if (mode === 'proxy' && service.path) {
        if (creds && creds.rpcuser && creds.rpcpassword) {
          return `${scheme}://${creds.rpcuser}:${creds.rpcpassword}@${host}${service.path}`;
        }
        return `${scheme}://${host}${service.path}`;
      }

      if (creds && creds.rpcuser && creds.rpcpassword) {
        return `${scheme}://${creds.rpcuser}:${creds.rpcpassword}@${host}:${port}`;
      }
      return `${scheme}://${host}:${port}`;
    }

    // For TCP/Electrum-style connections
    if (service.serviceName.includes('electr')) {
      const sslFlag = mode === 'proxy' ? 's' : 't'; // s for SSL, t for TCP
      return `${host}:${port}:${sslFlag}`;
    }

    return `${host}:${port}`;
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Connection Info" size="lg">
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="animate-spin text-bitcoin" size={32} />
        </div>
      ) : error ? (
        <div className="p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-400">
          {error}
        </div>
      ) : connectionInfo ? (
        <div className="space-y-6">
          <p className="text-gray-500 dark:text-gray-400 text-sm">
            Use these details to connect external apps like Fully Noded, Zeus, Sparrow, or Electrum.
          </p>

          {connectionInfo.services.map((service) => (
            <ServiceConnectionCard
              key={service.serviceName}
              service={service}
              showSecrets={showSecrets}
              toggleSecret={toggleSecret}
              copyToClipboard={copyToClipboard}
              copied={copied}
              showQR={showQR}
              setShowQR={setShowQR}
              buildConnectionUrl={buildConnectionUrl}
            />
          ))}
        </div>
      ) : null}
    </Modal>
  );
}

interface ServiceConnectionCardProps {
  service: ServiceConnectionInfo;
  showSecrets: Record<string, boolean>;
  toggleSecret: (key: string) => void;
  copyToClipboard: (text: string, key: string) => void;
  copied: string | null;
  showQR: string | null;
  setShowQR: (key: string | null) => void;
  buildConnectionUrl: (service: ServiceConnectionInfo, mode?: 'proxy' | 'direct' | 'tor') => string;
}

function ServiceConnectionCard({
  service,
  showSecrets,
  toggleSecret,
  copyToClipboard,
  copied,
  showQR,
  setShowQR,
  buildConnectionUrl,
}: ServiceConnectionCardProps) {
  const serviceKey = service.serviceName;
  const isHttpService = service.protocol === 'http';

  return (
    <div className="bg-gray-100 dark:bg-gray-900 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">{service.serviceName}</h3>
        <span className="text-xs bg-gray-200 dark:bg-gray-700 px-2 py-1 rounded">{service.protocol.toUpperCase()}</span>
      </div>

      {/* Proxied Connection (Recommended) */}
      <div className="space-y-2">
        <div className="text-sm font-medium text-green-400 flex items-center gap-1">
          <Server size={14} />
          External Connection (via Caddy)
        </div>
        <ConnectionField
          icon={<Server size={14} />}
          label="Host"
          value={service.host}
          copyKey={`${serviceKey}-host`}
          copied={copied}
          onCopy={copyToClipboard}
        />
        {isHttpService && service.path ? (
          <ConnectionField
            icon={<Server size={14} />}
            label="Path"
            value={service.path}
            copyKey={`${serviceKey}-path`}
            copied={copied}
            onCopy={copyToClipboard}
          />
        ) : (
          <ConnectionField
            icon={<Server size={14} />}
            label="Port"
            value={String(service.port || service.directPort)}
            copyKey={`${serviceKey}-port`}
            copied={copied}
            onCopy={copyToClipboard}
          />
        )}
        <div className="text-xs text-gray-500 pl-6">
          {isHttpService ? 'Uses HTTPS with TLS' : 'Uses TLS encryption'}
        </div>
      </div>

      {/* Direct Connection (Internal) */}
      <div className="pt-2 border-t border-gray-200 dark:border-gray-800 space-y-2">
        <div className="text-sm font-medium text-gray-500 flex items-center gap-1">
          <Server size={14} />
          Direct Connection (internal only)
        </div>
        <div className="text-xs bg-gray-50 dark:bg-gray-800 rounded px-3 py-2 text-gray-600 dark:text-gray-400 font-mono">
          {service.directHost}:{service.directPort}
        </div>
      </div>

      {/* Tor Address */}
      {service.torAddress && (
        <div className="pt-2 border-t border-gray-200 dark:border-gray-800">
          <ConnectionField
            icon={<Globe size={14} />}
            label="Tor Address"
            value={service.torAddress}
            copyKey={`${serviceKey}-tor`}
            copied={copied}
            onCopy={copyToClipboard}
          />
        </div>
      )}

      {/* Credentials */}
      {service.credentials && Object.keys(service.credentials).length > 0 && (
        <div className="pt-2 border-t border-gray-200 dark:border-gray-800 space-y-2">
          <div className="text-sm font-medium text-gray-600 dark:text-gray-400 flex items-center gap-1">
            <Key size={14} />
            Credentials
          </div>
          {Object.entries(service.credentials).map(([key, value]) => (
            <CredentialField
              key={key}
              label={key}
              value={value}
              isVisible={showSecrets[`${serviceKey}-${key}`]}
              onToggle={() => toggleSecret(`${serviceKey}-${key}`)}
              copyKey={`${serviceKey}-${key}`}
              copied={copied}
              onCopy={copyToClipboard}
            />
          ))}
        </div>
      )}

      {/* QR Code Section */}
      <div className="pt-2 border-t border-gray-200 dark:border-gray-800">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowQR(showQR === `${serviceKey}-proxy` ? null : `${serviceKey}-proxy`)}
            className="flex items-center gap-2 px-3 py-2 bg-green-900/30 hover:bg-green-900/50 text-green-400 rounded text-sm transition-colors"
          >
            <QrCode size={16} />
            {showQR === `${serviceKey}-proxy` ? 'Hide' : 'QR (Recommended)'}
          </button>
          {service.torAddress && (
            <button
              onClick={() => setShowQR(showQR === `${serviceKey}-tor` ? null : `${serviceKey}-tor`)}
              className="flex items-center gap-2 px-3 py-2 bg-purple-900/30 hover:bg-purple-900/50 text-purple-400 rounded text-sm transition-colors"
            >
              <Globe size={16} />
              {showQR === `${serviceKey}-tor` ? 'Hide' : 'QR (Tor)'}
            </button>
          )}
        </div>

        {showQR === `${serviceKey}-proxy` && (
          <QRCodeDisplay
            value={buildConnectionUrl(service, 'proxy')}
            label="External Connection (via Caddy)"
          />
        )}

        {showQR === `${serviceKey}-tor` && service.torAddress && (
          <QRCodeDisplay
            value={buildConnectionUrl(service, 'tor')}
            label="Tor Connection"
          />
        )}
      </div>
    </div>
  );
}

interface ConnectionFieldProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  copyKey: string;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}

function ConnectionField({ icon, label, value, copyKey, copied, onCopy }: ConnectionFieldProps) {
  return (
    <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-800 rounded px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-400 dark:text-gray-500">{icon}</span>
        <span className="text-gray-500 dark:text-gray-400">{label}:</span>
        <span className="font-mono text-gray-800 dark:text-gray-200">{value}</span>
      </div>
      <button
        onClick={() => onCopy(value, copyKey)}
        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
        title="Copy to clipboard"
      >
        {copied === copyKey ? (
          <Check size={14} className="text-green-400" />
        ) : (
          <Copy size={14} className="text-gray-400" />
        )}
      </button>
    </div>
  );
}

interface CredentialFieldProps {
  label: string;
  value: string;
  isVisible: boolean;
  onToggle: () => void;
  copyKey: string;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}

function CredentialField({ label, value, isVisible, onToggle, copyKey, copied, onCopy }: CredentialFieldProps) {
  const displayValue = isVisible ? value : '••••••••••••••••';

  return (
    <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-800 rounded px-3 py-2">
      <div className="flex items-center gap-2 text-sm min-w-0 flex-1">
        <span className="text-gray-500 dark:text-gray-400 shrink-0">{label}:</span>
        <span className="font-mono text-gray-800 dark:text-gray-200 truncate">{displayValue}</span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onToggle}
          className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
          title={isVisible ? 'Hide' : 'Show'}
        >
          {isVisible ? (
            <EyeOff size={14} className="text-gray-400" />
          ) : (
            <Eye size={14} className="text-gray-400" />
          )}
        </button>
        <button
          onClick={() => onCopy(value, copyKey)}
          className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
          title="Copy to clipboard"
        >
          {copied === copyKey ? (
            <Check size={14} className="text-green-400" />
          ) : (
            <Copy size={14} className="text-gray-400" />
          )}
        </button>
      </div>
    </div>
  );
}

interface QRCodeDisplayProps {
  value: string;
  label: string;
}

function QRCodeDisplay({ value, label }: QRCodeDisplayProps) {
  const [copied, setCopied] = useState(false);

  const copyUrl = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-3 p-4 bg-white rounded-lg flex flex-col items-center">
      <QRCodeSVG value={value} size={200} level="M" />
      <p className="mt-2 text-gray-600 text-sm font-medium">{label}</p>
      <button
        onClick={copyUrl}
        className="mt-2 flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? 'Copied!' : 'Copy URL'}
      </button>
      <p className="mt-1 text-xs text-gray-400 font-mono break-all max-w-[200px] text-center">
        {value}
      </p>
    </div>
  );
}
