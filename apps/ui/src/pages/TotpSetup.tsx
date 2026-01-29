import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Key, Copy, Check, Loader2, AlertCircle, LogOut } from 'lucide-react';
import { api } from '../api/client';
import { useAuthStore } from '../stores/useAuthStore';

export function TotpSetup() {
  const navigate = useNavigate();
  const { user, setTotpSetupRequired, logout } = useAuthStore();

  const [setupData, setSetupData] = useState<{ secret: string; qrCode: string; backupCodes: string[] } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [step, setStep] = useState<'setup' | 'backup'>('setup');

  useEffect(() => {
    // Fetch TOTP setup data
    const fetchSetup = async () => {
      try {
        setLoading(true);
        const data = await api.setupTotp();
        setSetupData(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to setup 2FA');
      } finally {
        setLoading(false);
      }
    };

    fetchSetup();
  }, []);

  const handleVerify = async () => {
    try {
      setVerifying(true);
      setError(null);
      await api.verifyTotp(verifyCode);
      setStep('backup');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code');
    } finally {
      setVerifying(false);
    }
  };

  const handleComplete = () => {
    setTotpSetupRequired(false);
    navigate('/', { replace: true });
  };

  const handleLogout = async () => {
    await api.logout();
    logout();
    navigate('/login', { replace: true });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(text);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const copyAllBackupCodes = () => {
    if (setupData?.backupCodes) {
      const allCodes = setupData.backupCodes.join('\n');
      navigator.clipboard.writeText(allCodes);
      setCopiedCode('all');
      setTimeout(() => setCopiedCode(null), 2000);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gray-100 dark:bg-gray-900">
      <div className="max-w-lg w-full">
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto bg-yellow-600/20 rounded-full flex items-center justify-center mb-4">
            <Shield className="w-8 h-8 text-yellow-500" />
          </div>
          <h1 className="text-2xl font-bold mb-2">Two-Factor Authentication Required</h1>
          <p className="text-gray-500 dark:text-gray-400">
            {user?.username}, your account requires 2FA to be enabled.
            <br />
            Please complete the setup to continue.
          </p>
        </div>

        <div className="card p-6 md:p-8 shadow-xl">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-gray-500 dark:text-gray-400" />
            </div>
          ) : error && !setupData ? (
            <div className="text-center py-8">
              <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
              <p className="text-red-400 mb-4">{error}</p>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg"
              >
                Try Again
              </button>
            </div>
          ) : step === 'backup' ? (
            // Step 2: Save backup codes
            <div className="space-y-6">
              <div className="text-center">
                <div className="w-12 h-12 mx-auto bg-green-600/20 rounded-full flex items-center justify-center mb-3">
                  <Check className="w-6 h-6 text-green-400" />
                </div>
                <h2 className="text-lg font-semibold mb-2">2FA Enabled Successfully</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Save your backup codes in a safe place. You'll need them if you lose access to your authenticator.
                </p>
              </div>

              <div className="p-4 rounded-lg bg-gray-100 dark:bg-gray-700/50">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium">Backup Codes</span>
                  <button
                    onClick={copyAllBackupCodes}
                    className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                  >
                    {copiedCode === 'all' ? <Check size={12} /> : <Copy size={12} />}
                    Copy All
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {setupData?.backupCodes.map((code, i) => (
                    <button
                      key={i}
                      onClick={() => copyToClipboard(code)}
                      className="flex items-center justify-between px-3 py-2 font-mono text-sm rounded
                        bg-white hover:bg-gray-50 border border-gray-200 dark:bg-gray-600 dark:hover:bg-gray-500 dark:border-gray-600 transition-colors"
                    >
                      <span>{code}</span>
                      {copiedCode === code ? (
                        <Check size={14} className="text-green-400" />
                      ) : (
                        <Copy size={14} className="text-gray-400 dark:text-gray-500" />
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-3 rounded-lg bg-yellow-900/30 border border-yellow-700/50">
                <p className="text-sm text-yellow-300">
                  Each backup code can only be used once. Store them securely.
                </p>
              </div>

              <button
                onClick={handleComplete}
                className="w-full py-3 px-4 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors"
              >
                I've Saved My Codes - Continue
              </button>
            </div>
          ) : (
            // Step 1: Scan QR and verify
            <div className="space-y-6">
              {error && (
                <div className="p-3 bg-red-900/50 border border-red-700 rounded-lg flex items-center gap-2 text-red-300 text-sm">
                  <AlertCircle size={16} />
                  {error}
                </div>
              )}

              <div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold">1</div>
                  <span className="font-medium">Scan QR Code</span>
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 ml-8">
                  Use an authenticator app (Google Authenticator, Authy, etc.) to scan this code.
                </p>
                <div className="flex justify-center p-4 rounded-lg bg-white">
                  {setupData?.qrCode && (
                    <img src={setupData.qrCode} alt="TOTP QR Code" className="w-48 h-48" />
                  )}
                </div>
              </div>

              <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                <div className="text-sm text-gray-500 dark:text-gray-400 mb-2">
                  Or enter this code manually:
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 p-2 font-mono text-sm rounded bg-gray-100 dark:bg-gray-700 break-all">
                    {setupData?.secret}
                  </code>
                  <button
                    onClick={() => setupData?.secret && copyToClipboard(setupData.secret)}
                    className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                  >
                    {copiedCode === setupData?.secret ? (
                      <Check size={16} className="text-green-400" />
                    ) : (
                      <Copy size={16} />
                    )}
                  </button>
                </div>
              </div>

              <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold">2</div>
                  <span className="font-medium">Verify Code</span>
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3 ml-8">
                  Enter the 6-digit code from your authenticator app.
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    className="input-field text-center text-xl tracking-widest"
                    maxLength={6}
                    autoFocus
                  />
                  <button
                    onClick={handleVerify}
                    disabled={verifying || verifyCode.length !== 6}
                    className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-lg flex items-center gap-2 transition-colors"
                  >
                    {verifying ? <Loader2 size={16} className="animate-spin" /> : <Key size={16} />}
                    Verify
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Logout option */}
          {step === 'setup' && (
            <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={handleLogout}
                className="w-full flex items-center justify-center gap-2 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-red-400 transition-colors"
              >
                <LogOut size={16} />
                Sign out and use a different account
              </button>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-gray-400 dark:text-gray-500">
          Two-factor authentication is required by your organization's security policy.
        </p>
      </div>
    </div>
  );
}
