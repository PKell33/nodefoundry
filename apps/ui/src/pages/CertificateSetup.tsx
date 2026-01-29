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
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <button
          onClick={() => togglePlatform(platform)}
          className="w-full px-4 py-3 flex items-center justify-between bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          <div className="flex items-center gap-3">
            <Icon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <span className="font-medium text-gray-900 dark:text-white">{title}</span>
          </div>
          {isExpanded ? (
            <ChevronUp className="w-5 h-5 text-gray-400" />
          ) : (
            <ChevronDown className="w-5 h-5 text-gray-400" />
          )}
        </button>
        {isExpanded && (
          <div className="px-4 py-4 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700">
            {children}
          </div>
        )}
      </div>
    );
  };

  const CodeBlock = ({ children }: { children: string }) => (
    <pre className="bg-gray-100 dark:bg-gray-800 rounded-lg p-3 text-sm font-mono overflow-x-auto text-gray-800 dark:text-gray-200">
      {children}
    </pre>
  );

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 py-8 px-4">
      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="absolute top-4 right-4 p-2 rounded-lg transition-colors
          text-gray-500 hover:text-gray-900 hover:bg-gray-200 dark:text-gray-400 dark:hover:text-white dark:hover:bg-gray-800"
      >
        {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
      </button>

      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4">
            <Shield className="w-8 h-8 text-green-600 dark:text-green-400" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            Certificate Setup
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Install the root CA certificate to access OwnPrem securely without browser warnings.
          </p>
        </div>

        {/* Status Card */}
        <div className="card p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Step 1: Download Certificate
          </h2>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : certInfo?.available ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-green-800 dark:text-green-200 font-medium">Certificate Available</p>
                  <p className="text-green-700 dark:text-green-300 text-sm mt-1">
                    The Caddy root CA certificate is ready to download.
                  </p>
                </div>
              </div>

              <button
                onClick={handleDownload}
                disabled={downloading}
                className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white font-medium rounded-lg flex items-center justify-center gap-2 transition-colors"
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
            <div className="flex items-start gap-3 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <AlertCircle className="w-5 h-5 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-yellow-800 dark:text-yellow-200 font-medium">Certificate Not Available</p>
                <p className="text-yellow-700 dark:text-yellow-300 text-sm mt-1">
                  {certInfo?.message || 'Caddy may not have generated certificates yet. Try refreshing the page.'}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Installation Instructions */}
        <div className="card p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Step 2: Install Certificate
          </h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            After downloading, install the certificate on your device to trust it.
          </p>

          <div className="space-y-3">
            <PlatformSection platform="windows" icon={Monitor} title="Windows">
              <ol className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">1.</span>
                  <span>Double-click the downloaded <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">ownprem-ca.crt</code> file</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">2.</span>
                  <span>Click <strong>"Install Certificate..."</strong></span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">3.</span>
                  <span>Select <strong>"Local Machine"</strong> and click Next</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">4.</span>
                  <span>Select <strong>"Place all certificates in the following store"</strong></span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">5.</span>
                  <span>Click Browse and select <strong>"Trusted Root Certification Authorities"</strong></span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">6.</span>
                  <span>Click Next, then Finish</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">7.</span>
                  <span>Restart your browser</span>
                </li>
              </ol>
              <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  <strong>PowerShell (Admin):</strong>
                </p>
                <CodeBlock>{`Import-Certificate -FilePath "$env:USERPROFILE\\Downloads\\ownprem-ca.crt" -CertStoreLocation Cert:\\LocalMachine\\Root`}</CodeBlock>
              </div>
            </PlatformSection>

            <PlatformSection platform="macos" icon={Apple} title="macOS">
              <ol className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">1.</span>
                  <span>Double-click the downloaded <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">ownprem-ca.crt</code> file</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">2.</span>
                  <span>Keychain Access will open - select <strong>"System"</strong> keychain</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">3.</span>
                  <span>Find the certificate (search "Caddy"), double-click it</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">4.</span>
                  <span>Expand <strong>"Trust"</strong> section</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">5.</span>
                  <span>Set "When using this certificate" to <strong>"Always Trust"</strong></span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">6.</span>
                  <span>Close the window and enter your password</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white">7.</span>
                  <span>Restart your browser</span>
                </li>
              </ol>
              <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  <strong>Terminal:</strong>
                </p>
                <CodeBlock>{`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/ownprem-ca.crt`}</CodeBlock>
              </div>
            </PlatformSection>

            <PlatformSection platform="linux" icon={Terminal} title="Linux">
              <div className="space-y-4 text-sm text-gray-700 dark:text-gray-300">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white mb-2">Debian/Ubuntu:</p>
                  <CodeBlock>{`sudo cp ~/Downloads/ownprem-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates`}</CodeBlock>
                </div>
                <div>
                  <p className="font-medium text-gray-900 dark:text-white mb-2">Fedora/RHEL:</p>
                  <CodeBlock>{`sudo cp ~/Downloads/ownprem-ca.crt /etc/pki/ca-trust/source/anchors/
sudo update-ca-trust`}</CodeBlock>
                </div>
                <div>
                  <p className="font-medium text-gray-900 dark:text-white mb-2">Arch Linux:</p>
                  <CodeBlock>{`sudo trust anchor --store ~/Downloads/ownprem-ca.crt`}</CodeBlock>
                </div>
                <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">
                  <p className="text-yellow-800 dark:text-yellow-200">
                    <strong>Note:</strong> Some browsers (Firefox, Chrome) use their own certificate stores. You may need to import the certificate in browser settings as well.
                  </p>
                </div>
              </div>
            </PlatformSection>
          </div>
        </div>

        {/* Continue to Login */}
        <div className="card p-6 text-center">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            Step 3: Access OwnPrem
          </h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            After installing the certificate, you can access OwnPrem without security warnings.
          </p>
          <Link
            to="/login"
            className="inline-flex items-center gap-2 py-3 px-6 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors"
          >
            Continue to Login
            <ExternalLink className="w-4 h-4" />
          </Link>
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-sm text-gray-400 dark:text-gray-500">
          <span className="text-bitcoin">O</span>wnPrem - Sovereign Bitcoin Infrastructure
        </p>
      </div>
    </div>
  );
}
