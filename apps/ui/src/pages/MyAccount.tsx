import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { api, SessionInfo, TotpStatus } from '../api/client';
import { Loader2, AlertCircle, Monitor, Smartphone, Globe, LogOut, XCircle, Lock, Key, Copy, Check, ShieldCheck, ShieldOff, Shield, User } from 'lucide-react';
import Modal from '../components/Modal';
import { showError } from '../lib/toast';

export default function MyAccount() {
  const { user } = useAuthStore();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-2">My Account</h1>
        <p className="text-muted">Manage your account security and sessions</p>
      </div>

      {/* Account Info and 2FA side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Account Info */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <User size={20} className="text-muted" />
            <h2 className="text-lg font-semibold">Account Info</h2>
          </div>
          <div className="card p-4 h-[calc(100%-2.5rem)]">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-[var(--bg-tertiary)] rounded-full flex items-center justify-center">
                <User size={24} className="text-muted" />
              </div>
              <div>
                <div className="font-medium text-lg">{user?.username}</div>
                <div className="text-sm text-muted">
                  {user?.isSystemAdmin ? 'System Administrator' : user?.groups?.[0]?.role || 'User'}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Two-Factor Authentication */}
        <TwoFactorAuth />
      </div>

      {/* Session Management */}
      <SessionManagement />
    </div>
  );
}

function TwoFactorAuth() {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupData, setSetupData] = useState<{ secret: string; qrCode: string; backupCodes: string[] } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [showDisableForm, setShowDisableForm] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [showBackupCodes, setShowBackupCodes] = useState(false);
  const [regeneratingCodes, setRegeneratingCodes] = useState(false);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getTotpStatus();
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load 2FA status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleSetup = async () => {
    try {
      setError(null);
      const data = await api.setupTotp();
      setSetupData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to setup 2FA');
    }
  };

  const handleVerify = async () => {
    try {
      setVerifying(true);
      setError(null);
      await api.verifyTotp(verifyCode);
      setSetupData(null);
      setVerifyCode('');
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code');
    } finally {
      setVerifying(false);
    }
  };

  const handleDisable = async () => {
    try {
      setDisabling(true);
      setError(null);
      await api.disableTotp(disablePassword);
      setShowDisableForm(false);
      setDisablePassword('');
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid password');
    } finally {
      setDisabling(false);
    }
  };

  const handleRegenerateBackupCodes = async () => {
    if (!confirm('This will invalidate all existing backup codes. Continue?')) {
      return;
    }

    try {
      setRegeneratingCodes(true);
      const result = await api.regenerateBackupCodes();
      setSetupData({ secret: '', qrCode: '', backupCodes: result.backupCodes });
      setShowBackupCodes(true);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate codes');
    } finally {
      setRegeneratingCodes(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(text);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const cancelSetup = () => {
    setSetupData(null);
    setVerifyCode('');
    setShowBackupCodes(false);
    setError(null);
  };

  return (
    <section>
      <div className="flex items-center gap-2 mb-4">
        <Shield size={20} className="text-muted" />
        <h2 className="text-lg font-semibold">Two-Factor Authentication</h2>
      </div>

      <div className="card p-4">
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-6 h-6 animate-spin text-muted" />
          </div>
        ) : error && !setupData ? (
          <div className="flex items-center gap-3 text-red-500">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        ) : status?.enabled ? (
          // 2FA is enabled
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-600/20 rounded-full flex items-center justify-center">
                  <ShieldCheck size={20} className="text-green-500" />
                </div>
                <div>
                  <div className="font-medium">2FA is enabled</div>
                  <div className="text-sm text-muted">
                    {status.backupCodesRemaining} backup codes remaining
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={handleRegenerateBackupCodes}
                disabled={regeneratingCodes}
                className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors
                  bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)]
                  disabled:opacity-50"
              >
                {regeneratingCodes ? <Loader2 size={14} className="animate-spin" /> : <Key size={14} />}
                Regenerate Backup Codes
              </button>

              <button
                onClick={() => setShowDisableForm(!showDisableForm)}
                className="flex items-center gap-2 px-3 py-2 text-sm text-red-500 rounded-lg transition-colors
                  hover:bg-red-900/30"
              >
                <ShieldOff size={14} />
                Disable 2FA
              </button>
            </div>

            {showDisableForm && (
              <Modal
                isOpen={showDisableForm}
                onClose={() => {
                  setShowDisableForm(false);
                  setDisablePassword('');
                  setError(null);
                }}
                title="Disable Two-Factor Authentication"
                size="sm"
              >
                <div className="space-y-4">
                  <p className="text-sm text-muted">Enter your password to disable two-factor authentication:</p>
                  {error && (
                    <div className="p-3 bg-red-900/50 border border-red-700 rounded-lg text-red-300 text-sm">
                      {error}
                    </div>
                  )}
                  <input
                    type="password"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                    placeholder="Password"
                    className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg"
                  />
                  <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-color)]">
                    <button
                      onClick={() => {
                        setShowDisableForm(false);
                        setDisablePassword('');
                        setError(null);
                      }}
                      className="px-4 py-2 text-muted hover:text-[var(--text-primary)]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleDisable}
                      disabled={disabling || !disablePassword}
                      className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-800 disabled:cursor-not-allowed text-white font-medium rounded-lg flex items-center gap-2 transition-colors"
                    >
                      {disabling && <Loader2 size={16} className="animate-spin" />}
                      Disable 2FA
                    </button>
                  </div>
                </div>
              </Modal>
            )}
          </div>
        ) : (
          // 2FA is not enabled
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-[var(--bg-tertiary)] rounded-full flex items-center justify-center">
                <Lock size={20} className="text-muted" />
              </div>
              <div>
                <div className="font-medium">2FA is not enabled</div>
                <div className="text-sm text-muted">
                  Add an extra layer of security to your account
                </div>
              </div>
            </div>
            <button
              onClick={handleSetup}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
            >
              Enable 2FA
            </button>
          </div>
        )}
      </div>

      {/* 2FA Setup Modal */}
      {setupData && (
        <Modal
          isOpen={!!setupData}
          onClose={cancelSetup}
          title={showBackupCodes ? "Save Your Backup Codes" : "Setup Two-Factor Authentication"}
          size="lg"
        >
          {showBackupCodes ? (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                Store these codes in a safe place. Each code can only be used once.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {setupData.backupCodes.map((code, i) => (
                  <button
                    key={i}
                    onClick={() => copyToClipboard(code)}
                    className="flex items-center justify-between px-3 py-2 font-mono text-sm rounded
                      bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    <span>{code}</span>
                    {copiedCode === code ? (
                      <Check size={14} className="text-green-500" />
                    ) : (
                      <Copy size={14} className="text-muted" />
                    )}
                  </button>
                ))}
              </div>
              <div className="pt-4 border-t border-[var(--border-color)]">
                <button
                  onClick={cancelSetup}
                  className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {error && (
                <div className="p-3 bg-red-900/50 border border-red-700 rounded-lg flex items-center gap-2 text-red-300 text-sm">
                  <AlertCircle size={16} />
                  {error}
                </div>
              )}

              <div>
                <p className="text-sm text-muted mb-3">
                  1. Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
                </p>
                <div className="flex justify-center p-4 rounded-lg bg-white">
                  <img src={setupData.qrCode} alt="TOTP QR Code" className="w-48 h-48" />
                </div>
              </div>

              <div>
                <p className="text-sm text-muted mb-2">Or enter this code manually:</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 p-2 font-mono text-sm rounded bg-[var(--bg-primary)] break-all">
                    {setupData.secret}
                  </code>
                  <button
                    onClick={() => copyToClipboard(setupData.secret)}
                    className="p-2 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    {copiedCode === setupData.secret ? (
                      <Check size={16} className="text-green-500" />
                    ) : (
                      <Copy size={16} />
                    )}
                  </button>
                </div>
              </div>

              <div>
                <p className="text-sm text-muted mb-2">2. Enter the 6-digit code from your app to verify:</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    className="flex-1 px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg text-center text-xl tracking-widest"
                    maxLength={6}
                  />
                  <button
                    onClick={handleVerify}
                    disabled={verifying || verifyCode.length !== 6}
                    className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-800 disabled:cursor-not-allowed text-white font-medium rounded-lg flex items-center gap-2 transition-colors"
                  >
                    {verifying ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                    Verify
                  </button>
                </div>
              </div>

              <div className="border-t border-[var(--border-color)] pt-4">
                <p className="text-sm text-muted mb-2">
                  3. Save your backup codes (you'll need these if you lose access to your authenticator):
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {setupData.backupCodes.map((code, i) => (
                    <div key={i} className="px-3 py-1 font-mono text-sm rounded bg-[var(--bg-primary)]">
                      {code}
                    </div>
                  ))}
                </div>
              </div>

              <div className="pt-4 border-t border-[var(--border-color)]">
                <button
                  onClick={cancelSetup}
                  className="w-full py-2 text-sm text-muted hover:text-[var(--text-primary)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}

function SessionManagement() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const [confirmRevokeSession, setConfirmRevokeSession] = useState<string | null>(null);

  const fetchSessions = async () => {
    try {
      setLoading(true);
      setError(null);
      // Refresh token is sent via httpOnly cookie automatically
      const data = await api.getSessionsWithCurrent();
      setSessions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const handleRevokeSession = async (sessionId: string) => {
    try {
      setRevoking(sessionId);
      setConfirmRevokeSession(null);
      await api.revokeSession(sessionId);
      setSessions(sessions.filter(s => s.id !== sessionId));
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to revoke session');
    } finally {
      setRevoking(null);
    }
  };

  const handleRevokeOthers = async () => {
    try {
      setRevoking('all');
      setConfirmRevokeAll(false);
      // Refresh token is sent via httpOnly cookie automatically
      const result = await api.revokeOtherSessions();
      if (result.revokedCount > 0) {
        setSessions(sessions.filter(s => s.isCurrent));
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to revoke sessions');
    } finally {
      setRevoking(null);
    }
  };

  const parseUserAgent = (userAgent: string | null): { device: string; browser: string } => {
    if (!userAgent) return { device: 'Unknown', browser: 'Unknown' };

    let device = 'Desktop';
    let browser = 'Unknown';

    // Detect device
    if (/Mobile|Android|iPhone|iPad/i.test(userAgent)) {
      device = /iPhone|iPad/i.test(userAgent) ? 'iOS' : 'Android';
    } else if (/Windows/i.test(userAgent)) {
      device = 'Windows';
    } else if (/Mac/i.test(userAgent)) {
      device = 'macOS';
    } else if (/Linux/i.test(userAgent)) {
      device = 'Linux';
    }

    // Detect browser
    if (/Firefox/i.test(userAgent)) {
      browser = 'Firefox';
    } else if (/Edg/i.test(userAgent)) {
      browser = 'Edge';
    } else if (/Chrome/i.test(userAgent)) {
      browser = 'Chrome';
    } else if (/Safari/i.test(userAgent)) {
      browser = 'Safari';
    }

    return { device, browser };
  };

  const getDeviceIcon = (userAgent: string | null) => {
    if (!userAgent) return <Globe size={20} className="text-muted" />;
    if (/Mobile|Android|iPhone/i.test(userAgent)) {
      return <Smartphone size={20} className="text-muted" />;
    }
    return <Monitor size={20} className="text-muted" />;
  };

  const formatTimeAgo = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  const otherSessionsCount = sessions.filter(s => !s.isCurrent).length;

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Monitor size={20} className="text-muted" />
          <h2 className="text-lg font-semibold">Active Sessions</h2>
        </div>
        {otherSessionsCount > 0 && (
          <button
            onClick={() => setConfirmRevokeAll(true)}
            disabled={revoking !== null}
            className="flex items-center gap-2 px-3 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            <LogOut size={16} />
            End All Other Sessions
          </button>
        )}
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted" />
          </div>
        ) : error ? (
          <div className="p-4 flex items-center gap-3 text-red-500">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="p-8 text-center text-muted">
            No active sessions
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-color)]">
            {sessions.map(session => {
              const { device, browser } = parseUserAgent(session.userAgent);
              return (
                <div key={session.id} className="p-4 hover:bg-[var(--bg-secondary)] transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-1">
                        {getDeviceIcon(session.userAgent)}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{device}</span>
                          <span className="text-muted">-</span>
                          <span className="text-muted">{browser}</span>
                          {session.isCurrent && (
                            <span className="text-xs bg-green-600 px-2 py-0.5 rounded text-white">Current</span>
                          )}
                        </div>
                        <div className="text-sm text-muted mt-1 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <Globe size={12} />
                            <span className="font-mono">{session.ipAddress || 'Unknown IP'}</span>
                          </div>
                          <div>
                            Last active: {formatTimeAgo(session.lastUsedAt)}
                            {' · '}
                            Created: {new Date(session.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                    </div>
                    {!session.isCurrent && (
                      <button
                        onClick={() => setConfirmRevokeSession(session.id)}
                        disabled={revoking === session.id}
                        className="p-2 text-muted hover:text-red-500 hover:bg-[var(--bg-tertiary)] rounded transition-colors disabled:opacity-50"
                        title="End session"
                      >
                        {revoking === session.id ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <XCircle size={16} />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Confirm End All Sessions Modal */}
      {confirmRevokeAll && (
        <Modal
          isOpen={confirmRevokeAll}
          onClose={() => setConfirmRevokeAll(false)}
          title="End All Other Sessions"
          size="sm"
        >
          <div className="space-y-4">
            <p className="text-muted">
              Are you sure you want to end all other sessions? You will remain logged in on this device only.
            </p>
            <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-color)]">
              <button
                onClick={() => setConfirmRevokeAll(false)}
                className="px-4 py-2 text-muted hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                onClick={handleRevokeOthers}
                disabled={revoking === 'all'}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-800 text-white font-medium rounded-lg flex items-center gap-2 transition-colors"
              >
                {revoking === 'all' && <Loader2 size={16} className="animate-spin" />}
                End Sessions
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Confirm End Single Session Modal */}
      {confirmRevokeSession && (
        <Modal
          isOpen={!!confirmRevokeSession}
          onClose={() => setConfirmRevokeSession(null)}
          title="End Session"
          size="sm"
        >
          <div className="space-y-4">
            <p className="text-muted">
              Are you sure you want to end this session? The user will be logged out on that device.
            </p>
            <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-color)]">
              <button
                onClick={() => setConfirmRevokeSession(null)}
                className="px-4 py-2 text-muted hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                onClick={() => confirmRevokeSession && handleRevokeSession(confirmRevokeSession)}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors"
              >
                End Session
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
