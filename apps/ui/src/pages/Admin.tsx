import { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../stores/useAuthStore';
import { api, UserInfo, AuditLogEntry, Group, GroupWithMembers } from '../api/client';
import { Plus, Trash2, User, Shield, Loader2, AlertCircle, ScrollText, ChevronLeft, ChevronRight, Filter, Key, Users, UserPlus, UserMinus, ShieldCheck, ShieldOff } from 'lucide-react';
import Modal from '../components/Modal';
import { showError } from '../lib/toast';

type TabId = 'users' | 'groups' | 'audit';

export default function Admin() {
  const { user: currentUser } = useAuthStore();
  const [activeTab, setActiveTab] = useState<TabId>('users');

  // Redirect non-admins
  if (!currentUser?.isSystemAdmin) {
    return <Navigate to="/" replace />;
  }

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'users', label: 'Users', icon: <User size={18} /> },
    { id: 'groups', label: 'Groups', icon: <Users size={18} /> },
    { id: 'audit', label: 'Audit Log', icon: <ScrollText size={18} /> },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold mb-2">Administration</h1>
        <p className="text-muted">Manage users, groups, and view audit logs</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-[var(--border-color)]">
        <nav className="flex gap-1">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-500'
                  : 'border-transparent text-muted hover:text-[var(--text-primary)] hover:border-gray-300'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'users' && <UserManagement currentUserId={currentUser?.userId} />}
      {activeTab === 'groups' && <GroupManagement />}
      {activeTab === 'audit' && <AuditLog />}
    </div>
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
      showError(err instanceof Error ? err.message : 'Failed to create group');
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
      showError(err instanceof Error ? err.message : 'Failed to update group');
    }
  };

  const handleDeleteGroup = async (groupId: string, groupName: string) => {
    if (groupId === 'default') {
      showError('Cannot delete the default group');
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
      showError(err instanceof Error ? err.message : 'Failed to delete group');
    }
  };

  const handleAddMember = async (userId: string, role: 'admin' | 'operator' | 'viewer') => {
    if (!selectedGroup) return;
    try {
      await api.addUserToGroup(selectedGroup.id, userId, role);
      await fetchGroupDetails(selectedGroup.id);
      setShowAddMember(false);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to add member');
    }
  };

  const handleUpdateMemberRole = async (userId: string, role: 'admin' | 'operator' | 'viewer') => {
    if (!selectedGroup) return;
    try {
      await api.updateUserGroupRole(selectedGroup.id, userId, role);
      await fetchGroupDetails(selectedGroup.id);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to update role');
    }
  };

  const handleRemoveMember = async (userId: string, username: string) => {
    if (!selectedGroup) return;
    if (!confirm(`Remove "${username}" from this group?`)) return;
    try {
      await api.removeUserFromGroup(selectedGroup.id, userId);
      await fetchGroupDetails(selectedGroup.id);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  // Filter out users who are already members OR are system admins (they have full access already)
  const nonMembers = allUsers.filter(u =>
    !selectedGroup?.members.some(m => m.userId === u.id) && !u.is_system_admin
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Groups</h2>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus size={16} />
          New Group
        </button>
      </div>

      {showCreateForm && (
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
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Groups List */}
        <div className="card overflow-hidden">
          <div className="px-4 py-3 table-header border-b border-[var(--border-color)]">
            <h3 className="font-medium">All Groups</h3>
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
            <div className="divide-y divide-[var(--border-color)]">
              {groups.map(group => (
                <div
                  key={group.id}
                  className={`p-4 cursor-pointer transition-colors ${
                    selectedGroup?.id === group.id
                      ? 'bg-blue-50 dark:bg-blue-600/20 border-l-2 border-blue-500'
                      : 'hover:bg-[var(--bg-secondary)]'
                  }`}
                  onClick={() => fetchGroupDetails(group.id)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium flex items-center gap-2">
                        {group.name}
                        {group.id === 'default' && (
                          <span className="text-xs bg-[var(--bg-tertiary)] text-muted px-2 py-0.5 rounded">Default</span>
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
                className="p-1.5 text-muted hover:text-red-500 hover:bg-[var(--bg-tertiary)] rounded transition-colors"
                title="Delete group"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>

          {selectedGroup ? (
            <div className="p-4 space-y-4">
              {/* Group Settings */}
              <div className="flex items-center justify-between p-3 bg-[var(--bg-secondary)] rounded-lg">
                <div className="flex items-center gap-2">
                  <Shield size={16} className="text-muted" />
                  <span className="text-sm">Require 2FA for members</span>
                </div>
                {selectedGroup.id === 'default' ? (
                  <span className="text-xs text-muted">Not available for default group</span>
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
                  <h4 className="text-sm font-medium text-muted">Members ({selectedGroup.members.length})</h4>
                  <button
                    onClick={() => setShowAddMember(!showAddMember)}
                    className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-400"
                  >
                    <UserPlus size={14} />
                    Add Member
                  </button>
                </div>

                {showAddMember && nonMembers.length > 0 && (
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
                )}

                {selectedGroup.members.length === 0 ? (
                  <div className="text-sm text-muted text-center py-4">No members</div>
                ) : (
                  <div className="space-y-2">
                    {selectedGroup.members.map(member => (
                      <div key={member.userId} className="flex items-center justify-between p-2 bg-[var(--bg-secondary)] rounded">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 bg-[var(--bg-tertiary)] rounded-full flex items-center justify-center">
                            <User size={14} className="text-muted" />
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
                            className="text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2 py-1"
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
            <div className="p-8 text-center text-muted">
              Select a group to view details and manage members
            </div>
          )}
        </div>
      </div>
    </div>
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
        <label className="block text-sm font-medium text-muted mb-1">Group Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg"
          placeholder="e.g., Operators"
          required
          minLength={2}
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-muted mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg"
          placeholder="Optional description"
        />
      </div>
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          id="totpRequired"
          checked={totpRequired}
          onChange={(e) => setTotpRequired(e.target.checked)}
          className="w-4 h-4 rounded border-[var(--border-color)] bg-[var(--bg-primary)]"
        />
        <label htmlFor="totpRequired" className="text-sm text-muted">
          Require 2FA for all members
        </label>
      </div>
      <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-color)]">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-muted hover:text-[var(--text-primary)]">
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
        <label className="block text-sm font-medium text-muted mb-1">User</label>
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
        <label className="block text-sm font-medium text-muted mb-1">Role</label>
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
        <button onClick={onCancel} className="px-4 py-2 text-muted hover:text-[var(--text-primary)]">
          Cancel
        </button>
        <button
          onClick={() => selectedUser && onAdd(selectedUser, role)}
          disabled={!selectedUser}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded-lg font-medium"
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
      showError(err instanceof Error ? err.message : 'Failed to delete user');
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
      showError(err instanceof Error ? err.message : 'Failed to reset 2FA');
    } finally {
      setResettingTotp(null);
    }
  };

  const handleUserCreated = (user: UserInfo) => {
    setUsers([...users, user]);
    setShowCreateForm(false);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Users</h2>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus size={16} />
          Add User
        </button>
      </div>

      {showCreateForm && (
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
      )}

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
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">User</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Access</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">2FA</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Created</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Last Login</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-color)]">
              {users.map(user => (
                <tr key={user.id} className="hover:bg-[var(--bg-secondary)]">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-[var(--bg-tertiary)] rounded-full flex items-center justify-center">
                        <User size={16} className="text-muted" />
                      </div>
                      <span className="font-medium">{user.username}</span>
                      {user.id === currentUserId && (
                        <span className="text-xs bg-blue-600 px-2 py-0.5 rounded text-white">You</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {user.is_system_admin ? (
                      <div className="flex items-center gap-2">
                        <Shield size={14} className="text-yellow-500" />
                        <span className="text-yellow-500">System Admin</span>
                      </div>
                    ) : user.groups?.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {user.groups.slice(0, 2).map(g => (
                          <span key={g.groupId} className="text-xs px-2 py-0.5 rounded bg-[var(--bg-tertiary)]">
                            {g.groupName}: {g.role}
                          </span>
                        ))}
                        {user.groups.length > 2 && (
                          <span className="text-xs text-muted">+{user.groups.length - 2}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted text-sm">No groups</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {user.totp_enabled ? (
                      <div className="flex items-center gap-1.5 text-green-500">
                        <ShieldCheck size={14} />
                        <span className="text-sm">Enabled</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-muted">
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
                          className="p-2 text-muted hover:text-yellow-500 hover:bg-[var(--bg-tertiary)] rounded transition-colors disabled:opacity-50"
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
                          className="p-2 text-muted hover:text-red-500 hover:bg-[var(--bg-tertiary)] rounded transition-colors"
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
    </div>
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
        <div className="p-3 bg-red-900/50 border border-red-700 rounded-lg flex items-center gap-2 text-red-300 text-sm">
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-muted mb-1">Username</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg"
          placeholder="username"
          required
          minLength={3}
          pattern="^[a-zA-Z0-9_-]+$"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-muted mb-1">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg"
          placeholder="min 8 characters"
          required
          minLength={8}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-muted mb-1">Role</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as 'admin' | 'operator' | 'viewer')}
          className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg"
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
          className="px-4 py-2 text-muted hover:text-[var(--text-primary)] transition-colors"
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
    if (action.includes('failed') || action.includes('deleted')) return 'text-red-500';
    if (action.includes('created') || action === 'login') return 'text-green-500';
    if (action.includes('changed')) return 'text-yellow-500';
    return 'text-muted';
  };

  const formatAction = (action: string) => {
    return action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Audit Log</h2>
        <div className="flex items-center gap-2">
          <Filter size={16} className="text-muted" />
          <select
            value={selectedAction}
            onChange={(e) => {
              setSelectedAction(e.target.value);
              setOffset(0);
            }}
            className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-sm"
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
          <div className="p-4 flex items-center gap-3 text-red-500">
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
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted">Time</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted">Action</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted">User</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted">IP Address</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-color)]">
                  {logs.map(log => (
                    <tr key={log.id} className="hover:bg-[var(--bg-secondary)]">
                      <td className="px-4 py-3 text-sm text-muted whitespace-nowrap">
                        {new Date(log.timestamp).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-sm ${getActionColor(log.action)}`}>
                          {formatAction(log.action)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {log.username || <span className="text-muted">-</span>}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted font-mono">
                        {log.ipAddress || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted">
                        {log.details && Object.keys(log.details).length > 0 ? (
                          <span className="text-xs bg-[var(--bg-tertiary)] px-2 py-1 rounded font-mono">
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
              <span className="text-sm text-muted">
                Showing {offset + 1}-{Math.min(offset + limit, total)} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePrevPage}
                  disabled={offset === 0}
                  className="p-2 hover:bg-[var(--bg-tertiary)] rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  onClick={handleNextPage}
                  disabled={offset + limit >= total}
                  className="p-2 hover:bg-[var(--bg-tertiary)] rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
