import { useState, useEffect } from 'react';
import { useSystemStatus } from '../hooks/useApi';
import { useAuthStore } from '../stores/useAuthStore';
import { api, UserInfo } from '../api/client';
import { Plus, Trash2, User, Shield, Eye, Loader2, AlertCircle } from 'lucide-react';

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

      {/* User Management - Admin only */}
      {isAdmin && <UserManagement currentUserId={currentUser?.userId} />}

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
                    <div className="flex items-center gap-2">
                      {user.role === 'admin' ? (
                        <>
                          <Shield size={14} className="text-yellow-500" />
                          <span className="text-yellow-500">Admin</span>
                        </>
                      ) : (
                        <>
                          <Eye size={14} className="text-gray-400" />
                          <span className="text-gray-400">Viewer</span>
                        </>
                      )}
                    </div>
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

function CreateUserForm({
  onSuccess,
  onCancel,
}: {
  onSuccess: (user: UserInfo) => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'viewer'>('viewer');
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
            onChange={(e) => setRole(e.target.value as 'admin' | 'viewer')}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
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

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-400">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
