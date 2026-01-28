import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Lock, User, AlertCircle, Loader2, Sun, Moon, Shield } from 'lucide-react';
import { api } from '../api/client';
import { useAuthStore } from '../stores/useAuthStore';
import { useThemeStore } from '../stores/useThemeStore';

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setTokens, setUser, setError, setLoading, error, isLoading, clearError } = useAuthStore();
  const { theme, toggleTheme } = useThemeStore();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSetup, setIsSetup] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState('');

  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    if (isSetup && password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);

    try {
      if (totpRequired) {
        // Complete login with TOTP
        const response = await api.loginWithTotp(username, password, totpCode);
        setTokens(response.accessToken, response.refreshToken);
        setUser(response.user);
        navigate(from, { replace: true });
      } else if (isSetup) {
        // Setup mode
        await api.setup(username, password);
        // After setup, log in
        const response = await api.login(username, password);
        if ('totpRequired' in response && response.totpRequired) {
          setTotpRequired(true);
        } else {
          setTokens(response.accessToken, response.refreshToken);
          setUser(response.user);
          navigate(from, { replace: true });
        }
      } else {
        // Normal login
        const response = await api.login(username, password);
        if ('totpRequired' in response && response.totpRequired) {
          setTotpRequired(true);
        } else {
          setTokens(response.accessToken, response.refreshToken);
          setUser(response.user);
          navigate(from, { replace: true });
        }
      }
    } catch (err) {
      if (err instanceof Error) {
        // Check if this is a "no users" error - switch to setup mode
        if (err.message.includes('No users exist') || err.message.includes('setup')) {
          setIsSetup(true);
          setError('No admin account exists. Please create one.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Login failed');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleBackToLogin = () => {
    setTotpRequired(false);
    setTotpCode('');
    clearError();
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 dark:bg-gray-900 light:bg-gray-100">
      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="absolute top-4 right-4 p-2 rounded-lg transition-colors
          dark:text-gray-400 dark:hover:text-white dark:hover:bg-gray-800
          light:text-gray-500 light:hover:text-gray-900 light:hover:bg-gray-200"
      >
        {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
      </button>

      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold mb-2">
            <span className="text-bitcoin">N</span>odefoundry
          </h1>
          <p className="dark:text-gray-400 light:text-gray-500">
            {totpRequired
              ? 'Enter verification code'
              : isSetup
                ? 'Create Admin Account'
                : 'Sign in to your account'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="card p-6 md:p-8 shadow-xl">
          {error && (
            <div className="mb-6 p-4 bg-red-900/50 border border-red-700 rounded-lg flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-red-300 text-sm">{error}</p>
            </div>
          )}

          {totpRequired ? (
            // TOTP verification step
            <div className="space-y-5">
              <div className="text-center mb-4">
                <div className="w-12 h-12 mx-auto bg-blue-600/20 rounded-full flex items-center justify-center mb-3">
                  <Shield className="w-6 h-6 text-blue-400" />
                </div>
                <p className="text-sm dark:text-gray-400 light:text-gray-500">
                  Enter the 6-digit code from your authenticator app, or use a backup code.
                </p>
              </div>

              <div>
                <label htmlFor="totpCode" className="block text-sm font-medium dark:text-gray-300 light:text-gray-700 mb-2">
                  Verification Code
                </label>
                <input
                  id="totpCode"
                  type="text"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\s/g, ''))}
                  className="input-field text-center text-xl tracking-widest"
                  placeholder="000000"
                  required
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={8}
                />
              </div>

              <button
                type="submit"
                disabled={isLoading || totpCode.length < 6}
                className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-lg flex items-center justify-center gap-2 transition-colors"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  'Verify'
                )}
              </button>

              <button
                type="button"
                onClick={handleBackToLogin}
                className="w-full py-2 text-sm dark:text-gray-400 light:text-gray-500 hover:underline"
              >
                Back to login
              </button>
            </div>
          ) : (
            // Normal login / setup form
            <div className="space-y-5">
              <div>
                <label htmlFor="username" className="block text-sm font-medium dark:text-gray-300 light:text-gray-700 mb-2">
                  Username
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 dark:text-gray-500 light:text-gray-400" />
                  <input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="input-field pl-10"
                    placeholder="Enter username"
                    required
                    autoComplete="username"
                    autoFocus
                  />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium dark:text-gray-300 light:text-gray-700 mb-2">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 dark:text-gray-500 light:text-gray-400" />
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="input-field pl-10"
                    placeholder="Enter password"
                    required
                    autoComplete={isSetup ? 'new-password' : 'current-password'}
                  />
                </div>
              </div>

              {isSetup && (
                <div>
                  <label htmlFor="confirmPassword" className="block text-sm font-medium dark:text-gray-300 light:text-gray-700 mb-2">
                    Confirm Password
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 dark:text-gray-500 light:text-gray-400" />
                    <input
                      id="confirmPassword"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="input-field pl-10"
                      placeholder="Confirm password"
                      required
                      autoComplete="new-password"
                    />
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-lg flex items-center justify-center gap-2 transition-colors"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    {isSetup ? 'Creating Account...' : 'Signing in...'}
                  </>
                ) : (
                  isSetup ? 'Create Account' : 'Sign In'
                )}
              </button>

              {isSetup && (
                <p className="text-center text-sm dark:text-gray-400 light:text-gray-500">
                  This will create the initial admin account for NodeFoundry.
                </p>
              )}
            </div>
          )}
        </form>

        <p className="mt-6 text-center text-sm dark:text-gray-500 light:text-gray-400">
          Sovereign Bitcoin Infrastructure
        </p>
      </div>
    </div>
  );
}
