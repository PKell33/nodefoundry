import { useState, useEffect } from 'react';
import { useSystemStatus } from '../hooks/useApi';
import { useAuthStore } from '../stores/useAuthStore';
import { api, UserInfo, AuditLogEntry, SessionInfo, TotpStatus, Group, GroupWithMembers } from '../api/client';
import { Plus, Trash2, User, Shield, Loader2, AlertCircle, ScrollText, ChevronLeft, ChevronRight, Filter, Monitor, Smartphone, Globe, LogOut, XCircle, Lock, Key, Copy, Check, ShieldCheck, ShieldOff, Users, UserPlus, UserMinus } from 'lucide-react';
import Modal from '../components/Modal';

export default function Settings() {
  const { data: status } = useSystemStatus();
  const { user: currentUser } = useAuthStore();
  const isAdmin = currentUser?.isSystemAdmin;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-2">Settings</h1>
        <p className="text-muted">Configure your OwnPrem instance</p>
      </div>

      {/* Two-Factor Authentication */}
      <TwoFactorAuth />

      {/* Session Management */}
      <SessionManagement />

      {/* Group Management - Admin only */}
      {isAdmin && <GroupManagement />}

      {/* User Management - Admin only */}
      {isAdmin && <UserManagement currentUserId={currentUser?.userId} />}

      {/* Audit Log - Admin only */}
      {isAdmin && <AuditLog />}

      {/* System Info */}
      <section>
        <h2 className="text-lg font-semibold mb-4">System Information</h2>
        <div className="card p-4 space-y-3">
          <InfoRow label="Status" value={status?.status || 'Unknown'} />
          <InfoRow label="Servers" value={`${status?.servers.online || 0} / ${status?.servers.total || 0} online`} />
          <InfoRow label="Deployments" value={`${status?.deployments.running || 0} / ${status?.deployments.total || 0} running`} />
          <InfoRow label="Last Updated" value={status?.timestamp ? new Date(status.timestamp).toLocaleString() : 'Never'} />
        </div>
      </section>

      {/* About */}
      <section>
        <h2 className="text-lg font-semibold mb-4">About</h2>
        <div className="card p-4 space-y-3">
          <InfoRow label="Version" value="0.1.0" />
          <InfoRow label="Project" value="OwnPrem" />
          <div className="pt-2">
            <a
              href="https://github.com/PKell33/ownprem"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline text-sm"
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
        <Shield size={20} className="text-muted" />
        <h2 className="text-lg font-semibold">Your Two-Factor Authentication</h2>
        <span className="text-xs text-gray-500">(personal setting)</span>
      </div>

      <div className="card p-4">
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-6 h-6 animate-spin text-muted" />
          </div>
        ) : error && !setupData ? (
          <div className="flex items-center gap-3 text-red-600 dark:text-red-400">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        ) : status?.enabled ? (
          // 2FA is enabled
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-100 dark:bg-green-600/20 rounded-full flex items-center justify-center">
                  <ShieldCheck size={20} className="text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <div className="font-medium">Your 2FA is enabled</div>
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
                  bg-gray-100 hover:bg-[var(--bg-tertiary)] dark:hover:bg-gray-600
                  disabled:opacity-50"
              >
                {regeneratingCodes ? <Loader2 size={14} className="animate-spin" /> : <Key size={14} />}
                Regenerate Backup Codes
              </button>

              <button
                onClick={() => setShowDisableForm(!showDisableForm)}
                className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 rounded-lg transition-colors
                  hover:bg-red-100 dark:hover:bg-red-900/30"
              >
                <ShieldOff size={14} />
                Disable 2FA
              </button>
            </div>

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
                  <div className="p-3 bg-red-50 border border-red-200 dark:bg-red-900/50 dark:border-red-700 rounded-lg text-red-600 dark:text-red-300 text-sm">
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
                    className="px-4 py-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
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
          </div>
        ) : (
          // 2FA is not enabled
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-[var(--bg-tertiary)] rounded-full flex items-center justify-center">
                <Lock size={20} className="text-muted" />
              </div>
              <div>
                <div className="font-medium">Your 2FA is not enabled</div>
                <div className="text-sm text-muted">
                  Add an extra layer of security to your account
                </div>
              </div>
            </div>
            <button
              onClick={handleSetup}
              className="px-4 py-2 border border-blue-600 text-blue-600 hover:bg-blue-50 dark:border-0 dark:bg-blue-600 dark:hover:bg-blue-700 dark:text-white font-medium rounded-lg transition-colors"
            >
              Enable 2FA
            </button>
          </div>
        )}
      </div>

      {/* 2FA Setup Modal */}
      <Modal
        isOpen={!!setupData}
        onClose={cancelSetup}
        title={showBackupCodes ? "Save Your Backup Codes" : "Setup Two-Factor Authentication"}
        size="lg"
      >
        {setupData && (
          showBackupCodes ? (
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
                      <Check size={14} className="text-green-600 dark:text-green-400" />
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
                <div className="p-3 bg-red-50 border border-red-200 dark:bg-red-900/50 dark:border-red-700 rounded-lg flex items-center gap-2 text-red-600 dark:text-red-300 text-sm">
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
                      <Check size={16} className="text-green-600 dark:text-green-400" />
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
          )
        )}
      </Modal>
    </section>
  );
}

function GroupManagement() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<GroupWithMembers | null>(null);
  const [allUsers, setAllUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);

  const fetchGroups = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getGroups();
      setGroups(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load groups');
    } finally {
      setLoading(false);
    }
  };

  const fetchGroupDetails = async (groupId: string) => {
    try {
      const data = await api.getGroup(groupId);
      setSelectedGroup(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load group details');
    }
  };

  const fetchAllUsers = async () => {
    try {
      const data = await api.getUsers();
      setAllUsers(data);
    } catch {
      // Ignore - users might not have permission
    }
  };

  useEffect(() => {
    fetchGroups();
    fetchAllUsers();
  }, []);

  const handleCreateGroup = async (name: string, description: string, totpRequired: boolean) => {
    try {
      const newGroup = await api.createGroup(name, description, totpRequired);
      setGroups([...groups, newGroup]);
      setShowCreateForm(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create group');
    }
  };

  const handleUpdateGroup = async (groupId: string, totpRequired: boolean) => {
    try {
      await api.updateGroup(groupId, { totpRequired });
      setGroups(groups.map(g => g.id === groupId ? { ...g, totp_required: totpRequired } : g));
      if (selectedGroup?.id === groupId) {
        setSelectedGroup({ ...selectedGroup, totp_required: totpRequired });
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update group');
    }
  };

  const handleDeleteGroup = async (groupId: string, groupName: string) => {
    if (groupId === 'default') {
      alert('Cannot delete the default group');
      return;
    }
    if (!confirm(`Delete group "${groupName}"? Members will be removed from this group.`)) {
      return;
    }
    try {
      await api.deleteGroup(groupId);
      setGroups(groups.filter(g => g.id !== groupId));
      if (selectedGroup?.id === groupId) {
        setSelectedGroup(null);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete group');
    }
  };

  const handleAddMember = async (userId: string, role: 'admin' | 'operator' | 'viewer') => {
    if (!selectedGroup) return;
    try {
      await api.addUserToGroup(selectedGroup.id, userId, role);
      await fetchGroupDetails(selectedGroup.id);
      setShowAddMember(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to add member');
    }
  };

  const handleUpdateMemberRole = async (userId: string, role: 'admin' | 'operator' | 'viewer') => {
    if (!selectedGroup) return;
    try {
      await api.updateUserGroupRole(selectedGroup.id, userId, role);
      await fetchGroupDetails(selectedGroup.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update role');
    }
  };

  const handleRemoveMember = async (userId: string, username: string) => {
    if (!selectedGroup) return;
    if (!confirm(`Remove "${username}" from this group?`)) return;
    try {
      await api.removeUserFromGroup(selectedGroup.id, userId);
      await fetchGroupDetails(selectedGroup.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  // Filter out users who are already members OR are system admins (they have full access already)
  const nonMembers = allUsers.filter(u =>
    !selectedGroup?.members.some(m => m.userId === u.id) && !u.is_system_admin
  );

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Users size={20} className="text-muted" />
          <h2 className="text-lg font-semibold">Group Management</h2>
        </div>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="flex items-center gap-2 px-3 py-2 border border-blue-600 text-blue-600 hover:bg-blue-50 dark:border-0 dark:bg-blue-600 dark:hover:bg-blue-700 dark:text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus size={16} />
          New Group
        </button>
      </div>

      <Modal
        isOpen={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        title="Create New Group"
        size="md"
      >
        <CreateGroupForm
          onSubmit={handleCreateGroup}
          onCancel={() => setShowCreateForm(false)}
        />
      </Modal>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Groups List */}
        <div className="card overflow-hidden">
          <div className="px-4 py-3 table-header border-b border-[var(--border-color)]">
            <h3 className="font-medium">Groups</h3>
          </div>
          {loading ? (
            <div className="p-8 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-muted" />
            </div>
          ) : error ? (
            <div className="p-4 flex items-center gap-3 text-red-600 dark:text-red-400">
              <AlertCircle size={20} />
              <span>{error}</span>
            </div>
          ) : groups.length === 0 ? (
            <div className="p-8 text-center text-muted">No groups found</div>
          ) : (
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
              {groups.map(group => (
                <div
                  key={group.id}
                  className={`p-4 cursor-pointer transition-colors ${
                    selectedGroup?.id === group.id
                      ? 'bg-blue-50 dark:bg-blue-600/20 border-l-2 border-blue-500'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-700/50'
                  }`}
                  onClick={() => fetchGroupDetails(group.id)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium flex items-center gap-2">
                        {group.name}
                        {group.id === 'default' && (
                          <span className="text-xs bg-gray-200 text-gray-600 dark:bg-gray-600 dark:text-gray-300 px-2 py-0.5 rounded">Default</span>
                        )}
                      </div>
                      <div className="text-sm text-muted">{group.description || 'No description'}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {group.totp_required && (
                        <span className="text-xs bg-yellow-100 text-yellow-700 dark:bg-yellow-600/30 dark:text-yellow-400 px-2 py-0.5 rounded flex items-center gap-1">
                          <Shield size={12} />
                          2FA Required
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Group Details */}
        <div className="card overflow-hidden">
          <div className="px-4 py-3 table-header border-b border-[var(--border-color)] flex items-center justify-between">
            <h3 className="font-medium">
              {selectedGroup ? selectedGroup.name : 'Select a group'}
            </h3>
            {selectedGroup && selectedGroup.id !== 'default' && (
              <button
                onClick={() => handleDeleteGroup(selectedGroup.id, selectedGroup.name)}
                className="p-1.5 text-muted hover:text-red-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                title="Delete group"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>

          {selectedGroup ? (
            <div className="p-4 space-y-4">
              {/* Group Settings */}
              <div className="flex items-center justify-between p-3 bg-[var(--bg-secondary)]/30 rounded-lg">
                <div className="flex items-center gap-2">
                  <Shield size={16} className="text-muted" />
                  <span className="text-sm">Require 2FA for members</span>
                </div>
                {selectedGroup.id === 'default' ? (
                  <span className="text-xs text-gray-500">Not available for default group</span>
                ) : (
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedGroup.totp_required}
                      onChange={(e) => handleUpdateGroup(selectedGroup.id, e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-gray-300 dark:bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                  </label>
                )}
              </div>

              {/* Members */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-medium text-[var(--text-secondary)]">Members ({selectedGroup.members.length})</h4>
                  <button
                    onClick={() => setShowAddMember(!showAddMember)}
                    className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                  >
                    <UserPlus size={14} />
                    Add Member
                  </button>
                </div>

                <Modal
                  isOpen={showAddMember && nonMembers.length > 0}
                  onClose={() => setShowAddMember(false)}
                  title="Add Member"
                  size="sm"
                >
                  <AddMemberForm
                    users={nonMembers}
                    onAdd={handleAddMember}
                    onCancel={() => setShowAddMember(false)}
                  />
                </Modal>

                {selectedGroup.members.length === 0 ? (
                  <div className="text-sm text-gray-500 text-center py-4">No members</div>
                ) : (
                  <div className="space-y-2">
                    {selectedGroup.members.map(member => (
                      <div key={member.userId} className="flex items-center justify-between p-2 bg-[var(--bg-secondary)]/30 rounded">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 bg-[var(--bg-tertiary)] rounded-full flex items-center justify-center">
                            <User size={14} className="text-gray-300" />
                          </div>
                          <span className="text-sm">{member.username}</span>
                          {member.isSystemAdmin && (
                            <span className="text-xs bg-yellow-100 text-yellow-700 dark:bg-yellow-600/30 dark:text-yellow-400 px-1.5 py-0.5 rounded">Admin</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            value={member.role}
                            onChange={(e) => handleUpdateMemberRole(member.userId, e.target.value as 'admin' | 'operator' | 'viewer')}
                            className="text-xs bg-[var(--bg-secondary)] border border-gray-300 dark:border-gray-600 rounded px-2 py-1"
                          >
                            <option value="admin">Admin</option>
                            <option value="operator">Operator</option>
                            <option value="viewer">Viewer</option>
                          </select>
                          <button
                            onClick={() => handleRemoveMember(member.userId, member.username)}
                            className="p-1 text-muted hover:text-red-500 transition-colors"
                            title="Remove from group"
                          >
                            <UserMinus size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="p-8 text-center text-gray-500">
              Select a group to view details and manage members
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function CreateGroupForm({ onSubmit, onCancel }: {
  onSubmit: (name: string, description: string, totpRequired: boolean) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(name, description, totpRequired);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Group Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)]"
          placeholder="e.g., Operators"
          required
          minLength={2}
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)]"
          placeholder="Optional description"
        />
      </div>
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          id="totpRequired"
          checked={totpRequired}
          onChange={(e) => setTotpRequired(e.target.checked)}
          className="w-4 h-4 rounded border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-700"
        />
        <label htmlFor="totpRequired" className="text-sm text-[var(--text-secondary)]">
          Require 2FA for all members
        </label>
      </div>
      <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-color)]">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          Cancel
        </button>
        <button
          type="submit"
          disabled={!name.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white rounded-lg font-medium"
        >
          Create Group
        </button>
      </div>
    </form>
  );
}

function AddMemberForm({ users, onAdd, onCancel }: {
  users: UserInfo[];
  onAdd: (userId: string, role: 'admin' | 'operator' | 'viewer') => void;
  onCancel: () => void;
}) {
  const [selectedUser, setSelectedUser] = useState('');
  const [role, setRole] = useState<'admin' | 'operator' | 'viewer'>('viewer');

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">User</label>
        <select
          value={selectedUser}
          onChange={(e) => setSelectedUser(e.target.value)}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg"
        >
          <option value="">Select user...</option>
          {users.map(u => (
            <option key={u.id} value={u.id}>{u.username}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Role</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as 'admin' | 'operator' | 'viewer')}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg"
        >
          <option value="viewer">Viewer</option>
          <option value="operator">Operator</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-color)]">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          Cancel
        </button>
        <button
          onClick={() => selectedUser && onAdd(selectedUser, role)}
          disabled={!selectedUser}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded-lg font-medium"
        >
          Add Member
        </button>
      </div>
    </div>
  );
}

function UserManagement({ currentUserId }: { currentUserId?: string }) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [resettingTotp, setResettingTotp] = useState<string | null>(null);

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

  const handleResetTotp = async (userId: string, username: string) => {
    if (!confirm(`Reset 2FA for user "${username}"? They will need to set up 2FA again on their next login.`)) {
      return;
    }

    try {
      setResettingTotp(userId);
      await api.resetUserTotp(userId);
      setUsers(users.map(u => u.id === userId ? { ...u, totp_enabled: false } : u));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to reset 2FA');
    } finally {
      setResettingTotp(null);
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
          className="flex items-center gap-2 px-3 py-2 border border-blue-600 text-blue-600 hover:bg-blue-50 dark:border-0 dark:bg-blue-600 dark:hover:bg-blue-700 dark:text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus size={16} />
          Add User
        </button>
      </div>

      <Modal
        isOpen={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        title="Create New User"
        size="md"
      >
        <CreateUserForm
          onSuccess={handleUserCreated}
          onCancel={() => setShowCreateForm(false)}
        />
      </Modal>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted" />
          </div>
        ) : error ? (
          <div className="p-4 flex items-center gap-3 text-red-600 dark:text-red-400">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-muted">
            No users found
          </div>
        ) : (
          <table className="w-full">
            <thead className="table-header">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-[var(--text-secondary)]">User</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-[var(--text-secondary)]">Access</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-[var(--text-secondary)]">2FA</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-[var(--text-secondary)]">Created</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-[var(--text-secondary)]">Last Login</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-[var(--text-secondary)]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {users.map(user => (
                <tr key={user.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-[var(--bg-tertiary)] rounded-full flex items-center justify-center">
                        <User size={16} className="text-gray-300" />
                      </div>
                      <span className="font-medium">{user.username}</span>
                      {user.id === currentUserId && (
                        <span className="text-xs bg-blue-600 px-2 py-0.5 rounded">You</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {user.is_system_admin ? (
                      <div className="flex items-center gap-2">
                        <Shield size={14} className="text-yellow-600 dark:text-yellow-500" />
                        <span className="text-yellow-600 dark:text-yellow-500">System Admin</span>
                      </div>
                    ) : user.groups?.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {user.groups.slice(0, 2).map(g => (
                          <span key={g.groupId} className="text-xs px-2 py-0.5 rounded bg-[var(--bg-secondary)]">
                            {g.groupName}: {g.role}
                          </span>
                        ))}
                        {user.groups.length > 2 && (
                          <span className="text-xs text-gray-500">+{user.groups.length - 2}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-500 text-sm">No groups</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {user.totp_enabled ? (
                      <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
                        <ShieldCheck size={14} />
                        <span className="text-sm">Enabled</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-gray-500">
                        <ShieldOff size={14} />
                        <span className="text-sm">Disabled</span>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted text-sm">
                    {new Date(user.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-muted text-sm">
                    {user.last_login_at
                      ? new Date(user.last_login_at).toLocaleString()
                      : 'Never'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {user.id !== currentUserId && user.totp_enabled && (
                        <button
                          onClick={() => handleResetTotp(user.id, user.username)}
                          disabled={resettingTotp === user.id}
                          className="p-2 text-muted hover:text-yellow-600 dark:hover:text-yellow-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors disabled:opacity-50"
                          title="Reset 2FA"
                        >
                          {resettingTotp === user.id ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            <Key size={16} />
                          )}
                        </button>
                      )}
                      {user.id !== currentUserId && (
                        <button
                          onClick={() => handleDeleteUser(user.id, user.username)}
                          className="p-2 text-muted hover:text-red-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                          title="Delete user"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
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
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const [confirmRevokeSession, setConfirmRevokeSession] = useState<string | null>(null);

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
    try {
      setRevoking(sessionId);
      setConfirmRevokeSession(null);
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
      return;
    }

    try {
      setRevoking('all');
      setConfirmRevokeAll(false);
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
          <div className="p-4 flex items-center gap-3 text-red-600 dark:text-red-400">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="p-8 text-center text-muted">
            No active sessions
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {sessions.map(session => {
              const { device, browser } = parseUserAgent(session.userAgent);
              return (
                <div key={session.id} className="p-4 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
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
              className="px-4 py-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
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

      {/* Confirm End Single Session Modal */}
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
              className="px-4 py-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
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
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 dark:bg-red-900/50 dark:border-red-700 rounded-lg flex items-center gap-2 text-red-600 dark:text-red-300 text-sm">
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Username</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="username"
          required
          minLength={3}
          pattern="^[a-zA-Z0-9_-]+$"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="min 8 characters"
          required
          minLength={8}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Role</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as 'admin' | 'operator' | 'viewer')}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="viewer">Viewer (read only)</option>
          <option value="operator">Operator (start/stop)</option>
          <option value="admin">Admin (full access)</option>
        </select>
      </div>

      <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-color)]">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white rounded-lg font-medium flex items-center gap-2 transition-colors"
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
    if (action.includes('failed') || action.includes('deleted')) return 'text-red-600 dark:text-red-400';
    if (action.includes('created') || action === 'login') return 'text-green-600 dark:text-green-400';
    if (action.includes('changed')) return 'text-yellow-600 dark:text-yellow-400';
    return 'text-gray-600 dark:text-gray-400';
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
          <ScrollText size={20} className="text-muted" />
          <h2 className="text-lg font-semibold">Audit Log</h2>
        </div>
        <div className="flex items-center gap-2">
          <Filter size={16} className="text-muted" />
          <select
            value={selectedAction}
            onChange={(e) => {
              setSelectedAction(e.target.value);
              setOffset(0);
            }}
            className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All actions</option>
            {actions.map(action => (
              <option key={action} value={action}>{formatAction(action)}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted" />
          </div>
        ) : error ? (
          <div className="p-4 flex items-center gap-3 text-red-600 dark:text-red-400">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center text-muted">
            No audit logs found
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="table-header">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-[var(--text-secondary)]">Time</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-[var(--text-secondary)]">Action</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-[var(--text-secondary)]">User</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-[var(--text-secondary)]">IP Address</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-[var(--text-secondary)]">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {logs.map(log => (
                    <tr key={log.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
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
                          <span className="text-xs bg-[var(--bg-secondary)] px-2 py-1 rounded font-mono">
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
            <div className="px-4 py-3 border-t border-[var(--border-color)] flex items-center justify-between">
              <span className="text-sm text-gray-400">
                Showing {offset + 1}-{Math.min(offset + limit, total)} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePrevPage}
                  disabled={offset === 0}
                  className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  onClick={handleNextPage}
                  disabled={offset + limit >= total}
                  className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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


function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-400">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
