import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Shield, Download, CheckCircle, AlertCircle, Monitor, Apple, Terminal, Sun, Moon, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { useThemeStore } from '../stores/useThemeStore';

interface CertInfo {
  available: boolean;
  message?: string;
}

type Platform = 'windows' | 'macos' | 'linux';

export function CertificateSetup() {
  const { theme, toggleTheme } = useThemeStore();
  const [certInfo, setCertInfo] = useState<CertInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [expandedPlatform, setExpandedPlatform] = useState<Platform | null>(null);

  useEffect(() => {
    fetch('/api/certificate/ca/info')
      .then((res) => res.json())
      .then((data) => {
        setCertInfo(data);
        setLoading(false);
      })
      .catch(() => {
        setCertInfo({ available: false, message: 'Failed to check certificate status' });
        setLoading(false);
      });
  }, []);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const response = await fetch('/api/certificate/ca');
      if (!response.ok) {
        throw new Error('Download failed');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ownprem-ca.crt';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error('Download failed:', err);
    } finally {
      setDownloading(false);
    }
  };

  const togglePlatform = (platform: Platform) => {
    setExpandedPlatform(expandedPlatform === platform ? null : platform);
  };

  const PlatformSection = ({
    platform,
    icon: Icon,
    title,
    children,
  }: {
    platform: Platform;
    icon: React.ElementType;
    title: string;
    children: React.ReactNode;
  }) => {
    const isExpanded = expandedPlatform === platform;
    return (
      <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-color, #292e42)' }}>
        <button
          onClick={() => togglePlatform(platform)}
          className="w-full px-4 py-3 flex items-center justify-between transition-colors"
          style={{ backgroundColor: 'var(--bg-secondary, #24283b)' }}
        >
          <div className="flex items-center gap-3">
            <Icon className="w-5 h-5" style={{ color: 'var(--text-muted, #565f89)' }} />
            <span className="font-medium" style={{ color: 'var(--text-primary, #c0caf5)' }}>{title}</span>
          </div>
          {isExpanded ? (
            <ChevronUp className="w-5 h-5" style={{ color: 'var(--text-muted, #565f89)' }} />
          ) : (
            <ChevronDown className="w-5 h-5" style={{ color: 'var(--text-muted, #565f89)' }} />
          )}
        </button>
        {isExpanded && (
          <div
            className="px-4 py-4"
            style={{
              backgroundColor: 'var(--bg-primary, #1a1b26)',
              borderTop: '1px solid var(--border-color, #292e42)'
            }}
          >
            {children}
          </div>
        )}
      </div>
    );
  };

  const CodeBlock = ({ children }: { children: string }) => (
    <pre
      className="rounded-lg p-3 text-sm font-mono overflow-x-auto"
      style={{
        backgroundColor: 'var(--bg-secondary, #24283b)',
        color: 'var(--text-primary, #c0caf5)'
      }}
    >
      {children}
    </pre>
  );

  return (
    <div className="min-h-screen py-8 px-4" style={{ backgroundColor: 'var(--bg-primary, #1a1b26)' }}>
      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="absolute top-4 right-4 p-2 rounded-lg transition-colors
          text-gray-500 hover:text-gray-900 hover:bg-gray-200 dark:hover:bg-gray-800"
        style={{ color: 'var(--text-muted, #565f89)' }}
      >
        {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
      </button>

      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-4" style={{ backgroundColor: 'rgba(158, 206, 106, 0.15)' }}>
            <Shield className="w-8 h-8" style={{ color: '#9ece6a' }} />
          </div>
          <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary, #c0caf5)' }}>
            Certificate Setup
          </h1>
          <p style={{ color: 'var(--text-muted, #565f89)' }}>
            Install the root CA certificate to access OwnPrem securely without browser warnings.
          </p>
        </div>

        {/* Status Card */}
        <div className="card p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary, #c0caf5)' }}>
            Step 1: Download Certificate
          </h2>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : certInfo?.available ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-lg" style={{ backgroundColor: 'rgba(158, 206, 106, 0.1)', border: '1px solid rgba(158, 206, 106, 0.3)' }}>
                <CheckCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#9ece6a' }} />
                <div>
                  <p className="font-medium" style={{ color: '#9ece6a' }}>Certificate Available</p>
                  <p className="text-sm mt-1" style={{ color: 'var(--text-secondary, #9aa5ce)' }}>
                    The Caddy root CA certificate is ready to download.
                  </p>
                </div>
              </div>

              <button
                onClick={handleDownload}
                disabled={downloading}
                className="w-full py-3 px-4 text-white font-medium rounded-lg flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
                style={{ background: 'linear-gradient(135deg, #7aa2f7 0%, #5a82d4 100%)' }}
              >
                {downloading ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    Downloading...
                  </>
                ) : (
                  <>
                    <Download className="w-5 h-5" />
                    Download ownprem-ca.crt
                  </>
                )}
              </button>
            </div>
          ) : (
            <div className="flex items-start gap-3 p-4 rounded-lg" style={{ backgroundColor: 'rgba(224, 175, 104, 0.1)', border: '1px solid rgba(224, 175, 104, 0.3)' }}>
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#e0af68' }} />
              <div>
                <p className="font-medium" style={{ color: '#e0af68' }}>Certificate Not Available</p>
                <p className="text-sm mt-1" style={{ color: 'var(--text-secondary, #9aa5ce)' }}>
                  {certInfo?.message || 'Caddy may not have generated certificates yet. Try refreshing the page.'}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Installation Instructions */}
        <div className="card p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary, #c0caf5)' }}>
            Step 2: Install Certificate
          </h2>
          <p className="mb-4" style={{ color: 'var(--text-muted, #565f89)' }}>
            After downloading, install the certificate on your device to trust it.
          </p>

          <div className="space-y-3">
            <PlatformSection platform="windows" icon={Monitor} title="Windows">
              <ol className="space-y-3 text-sm" style={{ color: 'var(--text-secondary, #9aa5ce)' }}>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>1.</span>
                  <span>Double-click the downloaded <code className="px-1 rounded" style={{ backgroundColor: 'var(--bg-secondary, #24283b)', color: 'var(--color-accent, #7aa2f7)' }}>ownprem-ca.crt</code> file</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>2.</span>
                  <span>Click <strong>"Install Certificate..."</strong></span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>3.</span>
                  <span>Select <strong>"Local Machine"</strong> and click Next</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>4.</span>
                  <span>Select <strong>"Place all certificates in the following store"</strong></span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>5.</span>
                  <span>Click Browse and select <strong>"Trusted Root Certification Authorities"</strong></span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>6.</span>
                  <span>Click Next, then Finish</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>7.</span>
                  <span>Restart your browser</span>
                </li>
              </ol>
              <div className="mt-4 p-3 rounded-lg" style={{ backgroundColor: 'rgba(122, 162, 247, 0.1)', border: '1px solid rgba(122, 162, 247, 0.2)' }}>
                <p className="text-sm" style={{ color: 'var(--color-accent, #7aa2f7)' }}>
                  <strong>PowerShell (Admin):</strong>
                </p>
                <CodeBlock>{`Import-Certificate -FilePath "$env:USERPROFILE\\Downloads\\ownprem-ca.crt" -CertStoreLocation Cert:\\LocalMachine\\Root`}</CodeBlock>
              </div>
            </PlatformSection>

            <PlatformSection platform="macos" icon={Apple} title="macOS">
              <ol className="space-y-3 text-sm" style={{ color: 'var(--text-secondary, #9aa5ce)' }}>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>1.</span>
                  <span>Double-click the downloaded <code className="px-1 rounded" style={{ backgroundColor: 'var(--bg-secondary, #24283b)', color: 'var(--color-accent, #7aa2f7)' }}>ownprem-ca.crt</code> file</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>2.</span>
                  <span>Keychain Access will open - select <strong>"System"</strong> keychain</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>3.</span>
                  <span>Find the certificate (search "Caddy"), double-click it</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>4.</span>
                  <span>Expand <strong>"Trust"</strong> section</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>5.</span>
                  <span>Set "When using this certificate" to <strong>"Always Trust"</strong></span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>6.</span>
                  <span>Close the window and enter your password</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold" style={{ color: 'var(--color-accent, #7aa2f7)' }}>7.</span>
                  <span>Restart your browser</span>
                </li>
              </ol>
              <div className="mt-4 p-3 rounded-lg" style={{ backgroundColor: 'rgba(122, 162, 247, 0.1)', border: '1px solid rgba(122, 162, 247, 0.2)' }}>
                <p className="text-sm" style={{ color: 'var(--color-accent, #7aa2f7)' }}>
                  <strong>Terminal:</strong>
                </p>
                <CodeBlock>{`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/ownprem-ca.crt`}</CodeBlock>
              </div>
            </PlatformSection>

            <PlatformSection platform="linux" icon={Terminal} title="Linux">
              <div className="space-y-4 text-sm" style={{ color: 'var(--text-secondary, #9aa5ce)' }}>
                <div>
                  <p className="font-medium mb-2" style={{ color: 'var(--text-primary, #c0caf5)' }}>Debian/Ubuntu:</p>
                  <CodeBlock>{`sudo cp ~/Downloads/ownprem-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates`}</CodeBlock>
                </div>
                <div>
                  <p className="font-medium mb-2" style={{ color: 'var(--text-primary, #c0caf5)' }}>Fedora/RHEL:</p>
                  <CodeBlock>{`sudo cp ~/Downloads/ownprem-ca.crt /etc/pki/ca-trust/source/anchors/
sudo update-ca-trust`}</CodeBlock>
                </div>
                <div>
                  <p className="font-medium mb-2" style={{ color: 'var(--text-primary, #c0caf5)' }}>Arch Linux:</p>
                  <CodeBlock>{`sudo trust anchor --store ~/Downloads/ownprem-ca.crt`}</CodeBlock>
                </div>
                <div className="p-3 rounded-lg" style={{ backgroundColor: 'rgba(224, 175, 104, 0.1)', border: '1px solid rgba(224, 175, 104, 0.2)' }}>
                  <p style={{ color: '#e0af68' }}>
                    <strong>Note:</strong> Some browsers (Firefox, Chrome) use their own certificate stores. You may need to import the certificate in browser settings as well.
                  </p>
                </div>
              </div>
            </PlatformSection>
          </div>
        </div>

        {/* Continue to Login */}
        <div className="card p-6 text-center">
          <h2 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary, #c0caf5)' }}>
            Step 3: Access OwnPrem
          </h2>
          <p className="mb-4" style={{ color: 'var(--text-muted, #565f89)' }}>
            After installing the certificate, you can access OwnPrem without security warnings.
          </p>
          <Link
            to="/login"
            className="inline-flex items-center gap-2 py-3 px-6 font-medium rounded-lg transition-colors"
            style={{
              background: 'linear-gradient(135deg, #7aa2f7 0%, #5a82d4 100%)',
              color: '#fff'
            }}
          >
            Continue to Login
            <ExternalLink className="w-4 h-4" />
          </Link>
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-sm" style={{ color: 'var(--text-muted, #565f89)' }}>
          <span>&#x232C;</span><span style={{ color: '#7aa2f7' }}>w</span><span>nPrem</span> - Sovereign Bitcoin Infrastructure
        </p>
      </div>
    </div>
  );
}
