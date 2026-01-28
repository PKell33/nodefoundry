import { useState, useEffect } from 'react';
import { useSystemStatus } from '../hooks/useApi';
import { useAuthStore } from '../stores/useAuthStore';
import { api, UserInfo, AuditLogEntry, SessionInfo, TotpStatus } from '../api/client';
import { Plus, Trash2, User, Shield, Eye, Wrench, Loader2, AlertCircle, ScrollText, ChevronLeft, ChevronRight, Filter, Monitor, Smartphone, Globe, LogOut, XCircle, Lock, Key, Copy, Check, ShieldCheck, ShieldOff } from 'lucide-react';

export default function Settings() {
  const { data: status } = useSystemStatus();
  const { user: currentUser } = useAuthStore();
  const isAdmin = currentUser?.role === 'admin';

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-2">Settings</h1>
        <p className="text-gray-400">Configure your Nodefoundry instance</p>
      </div>

      {/* Two-Factor Authentication */}
      <TwoFactorAuth />

      {/* Session Management */}
      <SessionManagement />

      {/* User Management - Admin only */}
      {isAdmin && <UserManagement currentUserId={currentUser?.userId} />}

      {/* Audit Log - Admin only */}
      {isAdmin && <AuditLog />}

      {/* System Info */}
      <section>
        <h2 className="text-lg font-semibold mb-4">System Information</h2>
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 space-y-3">
          <InfoRow label="Status" value={status?.status || 'Unknown'} />
          <InfoRow label="Servers" value={`${status?.servers.online || 0} / ${status?.servers.total || 0} online`} />
          <InfoRow label="Deployments" value={`${status?.deployments.running || 0} / ${status?.deployments.total || 0} running`} />
          <InfoRow label="Last Updated" value={status?.timestamp ? new Date(status.timestamp).toLocaleString() : 'Never'} />
        </div>
      </section>

      {/* About */}
      <section>
        <h2 className="text-lg font-semibold mb-4">About</h2>
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 space-y-3">
          <InfoRow label="Version" value="0.1.0" />
          <InfoRow label="Project" value="Nodefoundry" />
          <div className="pt-2">
            <a
              href="https://github.com/PKell33/nodefoundry"
              target="_blank"
              rel="noopener noreferrer"
              className="text-bitcoin hover:underline text-sm"
            >
              View on GitHub
            </a>
          </div>
        </div>
      </section>
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
        <Shield size={20} className="dark:text-gray-400 light:text-gray-500" />
        <h2 className="text-lg font-semibold">Two-Factor Authentication</h2>
      </div>

      <div className="card p-4">
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-6 h-6 animate-spin dark:text-gray-400 light:text-gray-500" />
          </div>
        ) : error && !setupData ? (
          <div className="flex items-center gap-3 text-red-400">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        ) : setupData ? (
          // Setup flow
          <div className="space-y-4">
            {showBackupCodes ? (
              // Show backup codes only
              <>
                <div className="flex items-center gap-2 text-green-400 mb-2">
                  <Check size={20} />
                  <span className="font-medium">Save Your Backup Codes</span>
                </div>
                <p className="text-sm dark:text-gray-400 light:text-gray-500 mb-3">
                  Store these codes in a safe place. Each code can only be used once.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {setupData.backupCodes.map((code, i) => (
                    <button
                      key={i}
                      onClick={() => copyToClipboard(code)}
                      className="flex items-center justify-between px-3 py-2 font-mono text-sm rounded
                        dark:bg-gray-700 dark:hover:bg-gray-600 light:bg-gray-100 light:hover:bg-gray-200
                        transition-colors"
                    >
                      <span>{code}</span>
                      {copiedCode === code ? (
                        <Check size={14} className="text-green-400" />
                      ) : (
                        <Copy size={14} className="dark:text-gray-500 light:text-gray-400" />
                      )}
                    </button>
                  ))}
                </div>
                <button
                  onClick={cancelSetup}
                  className="w-full mt-4 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
                >
                  Done
                </button>
              </>
            ) : (
              // Full setup flow
              <>
                <div className="flex items-center gap-2 mb-2">
                  <Key size={20} className="text-blue-400" />
                  <span className="font-medium">Setup Two-Factor Authentication</span>
                </div>

                {error && (
                  <div className="p-3 bg-red-900/50 border border-red-700 rounded-lg flex items-center gap-2 text-red-300 text-sm">
                    <AlertCircle size={16} />
                    {error}
                  </div>
                )}

                <div className="text-sm dark:text-gray-400 light:text-gray-500 mb-3">
                  1. Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
                </div>

                <div className="flex justify-center p-4 rounded-lg dark:bg-white light:bg-white">
                  <img src={setupData.qrCode} alt="TOTP QR Code" className="w-48 h-48" />
                </div>

                <div className="text-sm dark:text-gray-400 light:text-gray-500 mt-3">
                  Or enter this code manually:
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 p-2 font-mono text-sm rounded dark:bg-gray-700 light:bg-gray-100 break-all">
                    {setupData.secret}
                  </code>
                  <button
                    onClick={() => copyToClipboard(setupData.secret)}
                    className="p-2 rounded dark:hover:bg-gray-700 light:hover:bg-gray-200 transition-colors"
                  >
                    {copiedCode === setupData.secret ? (
                      <Check size={16} className="text-green-400" />
                    ) : (
                      <Copy size={16} />
                    )}
                  </button>
                </div>

                <div className="text-sm dark:text-gray-400 light:text-gray-500 mt-4">
                  2. Enter the 6-digit code from your app to verify:
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    className="input-field text-center text-xl tracking-widest"
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

                <div className="border-t dark:border-gray-700 light:border-gray-200 pt-4 mt-4">
                  <div className="text-sm dark:text-gray-400 light:text-gray-500 mb-2">
                    3. Save your backup codes (you'll need these if you lose access to your authenticator):
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {setupData.backupCodes.map((code, i) => (
                      <div key={i} className="px-3 py-1 font-mono text-sm rounded dark:bg-gray-700 light:bg-gray-100">
                        {code}
                      </div>
                    ))}
                  </div>
                </div>

                <button
                  onClick={cancelSetup}
                  className="w-full mt-4 py-2 text-sm dark:text-gray-400 light:text-gray-500 hover:underline"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        ) : status?.enabled ? (
          // 2FA is enabled
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-600/20 rounded-full flex items-center justify-center">
                  <ShieldCheck size={20} className="text-green-400" />
                </div>
                <div>
                  <div className="font-medium">Two-factor authentication is enabled</div>
                  <div className="text-sm dark:text-gray-400 light:text-gray-500">
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
                  dark:bg-gray-700 dark:hover:bg-gray-600 light:bg-gray-100 light:hover:bg-gray-200
                  disabled:opacity-50"
              >
                {regeneratingCodes ? <Loader2 size={14} className="animate-spin" /> : <Key size={14} />}
                Regenerate Backup Codes
              </button>

              <button
                onClick={() => setShowDisableForm(!showDisableForm)}
                className="flex items-center gap-2 px-3 py-2 text-sm text-red-400 rounded-lg transition-colors
                  dark:hover:bg-red-900/30 light:hover:bg-red-100"
              >
                <ShieldOff size={14} />
                Disable 2FA
              </button>
            </div>

            {showDisableForm && (
              <div className="p-4 rounded-lg dark:bg-gray-700/50 light:bg-gray-100 mt-2">
                <div className="text-sm mb-3">Enter your password to disable two-factor authentication:</div>
                {error && (
                  <div className="mb-3 p-2 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
                    {error}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                    placeholder="Password"
                    className="input-field"
                  />
                  <button
                    onClick={handleDisable}
                    disabled={disabling || !disablePassword}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-800 disabled:cursor-not-allowed text-white font-medium rounded-lg flex items-center gap-2 transition-colors"
                  >
                    {disabling && <Loader2 size={16} className="animate-spin" />}
                    Disable
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          // 2FA is not enabled
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 dark:bg-gray-700 light:bg-gray-200 rounded-full flex items-center justify-center">
                <Lock size={20} className="dark:text-gray-400 light:text-gray-500" />
              </div>
              <div>
                <div className="font-medium">Two-factor authentication is not enabled</div>
                <div className="text-sm dark:text-gray-400 light:text-gray-500">
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
    </section>
  );
}

function UserManagement({ currentUserId }: { currentUserId?: string }) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getUsers();
      setUsers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleDeleteUser = async (userId: string, username: string) => {
    if (!confirm(`Are you sure you want to delete user "${username}"?`)) {
      return;
    }

    try {
      await api.deleteUser(userId);
      setUsers(users.filter(u => u.id !== userId));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete user');
    }
  };

  const handleUserCreated = (user: UserInfo) => {
    setUsers([...users, user]);
    setShowCreateForm(false);
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">User Management</h2>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
        >
          <Plus size={16} />
          Add User
        </button>
      </div>

      {showCreateForm && (
        <CreateUserForm
          onSuccess={handleUserCreated}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : error ? (
          <div className="p-4 flex items-center gap-3 text-red-400">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            No users found
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-700/50">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">User</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Role</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Created</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Last Login</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-gray-300">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {users.map(user => (
                <tr key={user.id} className="hover:bg-gray-700/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center">
                        <User size={16} className="text-gray-300" />
                      </div>
                      <span className="font-medium">{user.username}</span>
                      {user.id === currentUserId && (
                        <span className="text-xs bg-blue-600 px-2 py-0.5 rounded">You</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <RoleBadge role={user.role} />
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-sm">
                    {new Date(user.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-sm">
                    {user.last_login_at
                      ? new Date(user.last_login_at).toLocaleString()
                      : 'Never'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {user.id !== currentUserId && (
                      <button
                        onClick={() => handleDeleteUser(user.id, user.username)}
                        className="p-2 text-gray-400 hover:text-red-400 hover:bg-gray-700 rounded transition-colors"
                        title="Delete user"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function SessionManagement() {
  const { refreshToken } = useAuthStore();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const fetchSessions = async () => {
    try {
      setLoading(true);
      setError(null);
      if (refreshToken) {
        const data = await api.getSessionsWithCurrent(refreshToken);
        setSessions(data);
      } else {
        const data = await api.getSessions();
        setSessions(data);
      }
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
    if (!confirm('Are you sure you want to end this session?')) {
      return;
    }

    try {
      setRevoking(sessionId);
      await api.revokeSession(sessionId);
      setSessions(sessions.filter(s => s.id !== sessionId));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to revoke session');
    } finally {
      setRevoking(null);
    }
  };

  const handleRevokeOthers = async () => {
    if (!refreshToken) {
      alert('Current session token not available');
      return;
    }

    if (!confirm('Are you sure you want to end all other sessions?')) {
      return;
    }

    try {
      setRevoking('all');
      const result = await api.revokeOtherSessions(refreshToken);
      if (result.revokedCount > 0) {
        setSessions(sessions.filter(s => s.isCurrent));
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to revoke sessions');
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
    if (!userAgent) return <Globe size={20} className="text-gray-400" />;
    if (/Mobile|Android|iPhone/i.test(userAgent)) {
      return <Smartphone size={20} className="text-gray-400" />;
    }
    return <Monitor size={20} className="text-gray-400" />;
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
          <Monitor size={20} className="text-gray-400" />
          <h2 className="text-lg font-semibold">Active Sessions</h2>
        </div>
        {otherSessionsCount > 0 && (
          <button
            onClick={handleRevokeOthers}
            disabled={revoking !== null}
            className="flex items-center gap-2 px-3 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            <LogOut size={16} />
            End All Other Sessions
          </button>
        )}
      </div>

      <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : error ? (
          <div className="p-4 flex items-center gap-3 text-red-400">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            No active sessions
          </div>
        ) : (
          <div className="divide-y divide-gray-700">
            {sessions.map(session => {
              const { device, browser } = parseUserAgent(session.userAgent);
              return (
                <div key={session.id} className="p-4 hover:bg-gray-700/30 transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-1">
                        {getDeviceIcon(session.userAgent)}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{device}</span>
                          <span className="text-gray-400">-</span>
                          <span className="text-gray-300">{browser}</span>
                          {session.isCurrent && (
                            <span className="text-xs bg-green-600 px-2 py-0.5 rounded">Current</span>
                          )}
                        </div>
                        <div className="text-sm text-gray-400 mt-1 space-y-0.5">
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
                        onClick={() => handleRevokeSession(session.id)}
                        disabled={revoking === session.id}
                        className="p-2 text-gray-400 hover:text-red-400 hover:bg-gray-700 rounded transition-colors disabled:opacity-50"
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
    </section>
  );
}

function CreateUserForm({
  onSuccess,
  onCancel,
}: {
  onSuccess: (user: UserInfo) => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'operator' | 'viewer'>('viewer');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const user = await api.createUser(username, password, role);
      onSuccess(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-4">
      <h3 className="font-medium mb-4">Create New User</h3>

      {error && (
        <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded-lg flex items-center gap-2 text-red-300 text-sm">
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="username"
            required
            minLength={3}
            pattern="^[a-zA-Z0-9_-]+$"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="min 8 characters"
            required
            minLength={8}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Role</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'admin' | 'operator' | 'viewer')}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="viewer">Viewer (read only)</option>
            <option value="operator">Operator (start/stop)</option>
            <option value="admin">Admin (full access)</option>
          </select>
        </div>
      </div>

      <div className="flex justify-end gap-3 mt-4">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-gray-300 hover:text-white transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 rounded-lg font-medium flex items-center gap-2 transition-colors"
        >
          {loading && <Loader2 size={16} className="animate-spin" />}
          Create User
        </button>
      </div>
    </form>
  );
}

function AuditLog() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [actions, setActions] = useState<string[]>([]);
  const [selectedAction, setSelectedAction] = useState<string>('');
  const limit = 20;

  const fetchLogs = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getAuditLogs({
        limit,
        offset,
        action: selectedAction || undefined,
      });
      setLogs(data.logs);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit logs');
    } finally {
      setLoading(false);
    }
  };

  const fetchActions = async () => {
    try {
      const data = await api.getAuditLogActions();
      setActions(data);
    } catch {
      // Ignore errors for action list
    }
  };

  useEffect(() => {
    fetchActions();
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [offset, selectedAction]);

  const handlePrevPage = () => {
    setOffset(Math.max(0, offset - limit));
  };

  const handleNextPage = () => {
    if (offset + limit < total) {
      setOffset(offset + limit);
    }
  };

  const getActionColor = (action: string) => {
    if (action.includes('failed') || action.includes('deleted')) return 'text-red-400';
    if (action.includes('created') || action === 'login') return 'text-green-400';
    if (action.includes('changed')) return 'text-yellow-400';
    return 'text-gray-400';
  };

  const getActionIcon = (action: string) => {
    if (action === 'login' || action === 'login_failed') return '🔐';
    if (action.includes('created')) return '➕';
    if (action.includes('deleted')) return '🗑️';
    if (action.includes('changed')) return '✏️';
    return '📋';
  };

  const formatAction = (action: string) => {
    return action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ScrollText size={20} className="text-gray-400" />
          <h2 className="text-lg font-semibold">Audit Log</h2>
        </div>
        <div className="flex items-center gap-2">
          <Filter size={16} className="text-gray-400" />
          <select
            value={selectedAction}
            onChange={(e) => {
              setSelectedAction(e.target.value);
              setOffset(0);
            }}
            className="px-3 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All actions</option>
            {actions.map(action => (
              <option key={action} value={action}>{formatAction(action)}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : error ? (
          <div className="p-4 flex items-center gap-3 text-red-400">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            No audit logs found
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-700/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Time</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Action</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">User</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">IP Address</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {logs.map(log => (
                    <tr key={log.id} className="hover:bg-gray-700/30">
                      <td className="px-4 py-3 text-sm text-gray-400 whitespace-nowrap">
                        {new Date(log.timestamp).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`flex items-center gap-2 text-sm ${getActionColor(log.action)}`}>
                          <span>{getActionIcon(log.action)}</span>
                          {formatAction(log.action)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {log.username || <span className="text-gray-500">-</span>}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-400 font-mono">
                        {log.ipAddress || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-400">
                        {log.details && Object.keys(log.details).length > 0 ? (
                          <span className="text-xs bg-gray-700 px-2 py-1 rounded font-mono">
                            {JSON.stringify(log.details)}
                          </span>
                        ) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="px-4 py-3 border-t border-gray-700 flex items-center justify-between">
              <span className="text-sm text-gray-400">
                Showing {offset + 1}-{Math.min(offset + limit, total)} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePrevPage}
                  disabled={offset === 0}
                  className="p-2 hover:bg-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  onClick={handleNextPage}
                  disabled={offset + limit >= total}
                  className="p-2 hover:bg-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function RoleBadge({ role }: { role: string }) {
  switch (role) {
    case 'admin':
      return (
        <div className="flex items-center gap-2">
          <Shield size={14} className="text-yellow-500" />
          <span className="text-yellow-500">Admin</span>
        </div>
      );
    case 'operator':
      return (
        <div className="flex items-center gap-2">
          <Wrench size={14} className="text-blue-400" />
          <span className="text-blue-400">Operator</span>
        </div>
      );
    default:
      return (
        <div className="flex items-center gap-2">
          <Eye size={14} className="text-gray-400" />
          <span className="text-gray-400">Viewer</span>
        </div>
      );
  }
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-400">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
