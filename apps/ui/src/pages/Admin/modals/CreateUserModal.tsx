import { useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import Modal from '../../../components/Modal';
import { api, UserInfo } from '../../../api/client';

type UserRole = 'admin' | 'operator' | 'viewer';

interface CreateUserModalProps {
  onSuccess: (user: UserInfo) => void;
  onClose: () => void;
}

/**
 * Modal for creating a new user.
 * IMPORTANT: Must be conditionally rendered with {showModal && <CreateUserModal />}
 */
export default function CreateUserModal({ onSuccess, onClose }: CreateUserModalProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('viewer');
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
    <Modal
      isOpen={true}
      onClose={onClose}
      title="Create New User"
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div
            role="alert"
            aria-live="polite"
            className="p-3 bg-red-900/50 border border-red-700 rounded-lg flex items-center gap-2 text-red-300 text-sm"
          >
            <AlertCircle size={16} aria-hidden="true" />
            {error}
          </div>
        )}

        <div>
          <label htmlFor="create-user-username" className="block text-sm font-medium text-muted mb-1">Username</label>
          <input
            id="create-user-username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg"
            placeholder="username"
            required
            aria-required="true"
            autoComplete="username"
            minLength={3}
            pattern="^[a-zA-Z0-9_-]+$"
          />
        </div>

        <div>
          <label htmlFor="create-user-password" className="block text-sm font-medium text-muted mb-1">Password</label>
          <input
            id="create-user-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg"
            placeholder="min 8 characters"
            required
            aria-required="true"
            autoComplete="new-password"
            minLength={8}
          />
        </div>

        <div>
          <label htmlFor="create-user-role" className="block text-sm font-medium text-muted mb-1">Role</label>
          <select
            id="create-user-role"
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
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
            onClick={onClose}
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
    </Modal>
  );
}
