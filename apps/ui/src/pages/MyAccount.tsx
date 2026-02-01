import { useState } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { api } from '../api/client';
import { Loader2, AlertCircle, User, Key, Check } from 'lucide-react';

export default function MyAccount() {
  const { user } = useAuthStore();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(false);

    try {
      await api.changePassword(currentPassword, newPassword);
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-2">My Account</h1>
        <p className="text-muted">Manage your account settings</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Account Info */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <User size={20} className="text-muted" />
            <h2 className="text-lg font-semibold">Account Info</h2>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-[var(--bg-tertiary)] rounded-full flex items-center justify-center">
                <User size={24} className="text-muted" />
              </div>
              <div>
                <div className="font-medium text-lg">{user?.username}</div>
                <div className="text-sm text-muted">
                  {user?.isSystemAdmin ? 'System Administrator' : 'User'}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Change Password */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Key size={20} className="text-muted" />
            <h2 className="text-lg font-semibold">Change Password</h2>
          </div>
          <div className="card p-4">
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-900/30 border border-red-700/50 text-red-300 text-sm">
                  <AlertCircle size={16} />
                  {error}
                </div>
              )}

              {success && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-green-900/30 border border-green-700/50 text-green-300 text-sm">
                  <Check size={16} />
                  Password changed successfully
                </div>
              )}

              <div>
                <label htmlFor="current-password" className="block text-sm font-medium mb-1">
                  Current Password
                </label>
                <input
                  id="current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label htmlFor="new-password" className="block text-sm font-medium mb-1">
                  New Password
                </label>
                <input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                  minLength={8}
                />
                <p className="mt-1 text-xs text-muted">At least 8 characters</p>
              </div>

              <div>
                <label htmlFor="confirm-password" className="block text-sm font-medium mb-1">
                  Confirm New Password
                </label>
                <input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={isLoading || !currentPassword || !newPassword || !confirmPassword}
                className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-lg flex items-center justify-center gap-2 transition-colors"
              >
                {isLoading && <Loader2 size={16} className="animate-spin" />}
                {isLoading ? 'Changing Password...' : 'Change Password'}
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
