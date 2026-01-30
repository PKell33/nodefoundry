import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Lock, User, AlertCircle, Loader2, Shield } from 'lucide-react';
import { api } from '../api/client';
import { useAuthStore } from '../stores/useAuthStore';
import { NodeNetwork } from '../components/NodeNetwork';

// Tokyo Night color palette
const styles = {
  card: {
    background: 'rgba(26, 27, 38, 0.8)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    borderRadius: '20px',
    border: '1px solid rgba(122, 162, 247, 0.2)',
    padding: '48px',
    maxWidth: '400px',
    width: '100%',
  },
  input: {
    background: 'rgba(15, 15, 23, 0.6)',
    border: '1px solid #292e42',
    borderRadius: '10px',
    color: '#c0caf5',
    padding: '12px 16px',
    paddingLeft: '44px',
    width: '100%',
    fontSize: '14px',
    outline: 'none',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  },
  inputFocus: {
    borderColor: '#7aa2f7',
    boxShadow: '0 0 0 2px rgba(122, 162, 247, 0.2)',
  },
  button: {
    background: 'linear-gradient(135deg, #7aa2f7 0%, #5a82d4 100%)',
    color: '#fff',
    border: 'none',
    borderRadius: '10px',
    padding: '14px 24px',
    fontSize: '15px',
    fontWeight: 600,
    cursor: 'pointer',
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    transition: 'transform 0.2s, box-shadow 0.2s',
  },
  buttonHover: {
    transform: 'translateY(-1px)',
    boxShadow: '0 4px 20px rgba(122, 162, 247, 0.4)',
  },
  buttonDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
    transform: 'none',
  },
};

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setTokens, setUser, setError, setLoading, error, isLoading, clearError, setTotpSetupRequired } = useAuthStore();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSetup, setIsSetup] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [isButtonHovered, setIsButtonHovered] = useState(false);

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
        // Check if this user needs to setup TOTP (shouldn't happen after TOTP login, but handle it)
        if ('totpSetupRequired' in response && response.totpSetupRequired) {
          setTotpSetupRequired(true);
          navigate('/setup-2fa', { replace: true });
        } else {
          navigate(from, { replace: true });
        }
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
          // Check if 2FA setup is required
          if ('totpSetupRequired' in response && response.totpSetupRequired) {
            setTotpSetupRequired(true);
            navigate('/setup-2fa', { replace: true });
          } else {
            navigate(from, { replace: true });
          }
        }
      } else {
        // Normal login
        const response = await api.login(username, password);
        if ('totpRequired' in response && response.totpRequired) {
          setTotpRequired(true);
        } else {
          setTokens(response.accessToken, response.refreshToken);
          setUser(response.user);
          // Check if 2FA setup is required
          if ('totpSetupRequired' in response && response.totpSetupRequired) {
            setTotpSetupRequired(true);
            navigate('/setup-2fa', { replace: true });
          } else {
            navigate(from, { replace: true });
          }
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

  const getInputStyle = (fieldName: string) => ({
    ...styles.input,
    ...(focusedField === fieldName ? styles.inputFocus : {}),
  });

  const getButtonStyle = () => ({
    ...styles.button,
    ...(isButtonHovered && !isLoading ? styles.buttonHover : {}),
    ...(isLoading ? styles.buttonDisabled : {}),
  });

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden">
      {/* Animated node network background */}
      <NodeNetwork />

      {/* Login card */}
      <div style={styles.card} className="relative z-10">
        {/* Logo */}
        <div className="text-center mb-2">
          <h1 className="text-4xl font-bold tracking-tight" style={{ color: '#c0caf5' }}>
            <span style={{ fontFamily: 'system-ui' }}>&#x232C;</span>
            <span style={{ color: '#7aa2f7' }}>w</span>
            <span>nPrem</span>
          </h1>
        </div>

        {/* Tagline */}
        <p className="text-center mb-8" style={{ color: '#565f89', fontSize: '14px' }}>
          {totpRequired
            ? 'Enter verification code'
            : isSetup
              ? 'Create Admin Account'
              : 'Orchestrate Everything'}
        </p>

        <form onSubmit={handleSubmit}>
          {error && (
            <div
              className="mb-6 p-4 rounded-lg flex items-start gap-3"
              style={{
                background: 'rgba(244, 63, 94, 0.15)',
                border: '1px solid rgba(244, 63, 94, 0.3)'
              }}
            >
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#f43f5e' }} />
              <p className="text-sm" style={{ color: '#fda4af' }}>{error}</p>
            </div>
          )}

          {totpRequired ? (
            // TOTP verification step
            <div className="space-y-5">
              <div className="text-center mb-4">
                <div
                  className="w-12 h-12 mx-auto rounded-full flex items-center justify-center mb-3"
                  style={{ background: 'rgba(122, 162, 247, 0.2)' }}
                >
                  <Shield className="w-6 h-6" style={{ color: '#7aa2f7' }} />
                </div>
                <p className="text-sm" style={{ color: '#565f89' }}>
                  Enter the 6-digit code from your authenticator app, or use a backup code.
                </p>
              </div>

              <div>
                <label
                  htmlFor="totpCode"
                  className="block text-sm font-medium mb-2"
                  style={{ color: '#c0caf5' }}
                >
                  Verification Code
                </label>
                <input
                  id="totpCode"
                  type="text"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\s/g, ''))}
                  onFocus={() => setFocusedField('totp')}
                  onBlur={() => setFocusedField(null)}
                  style={{
                    ...getInputStyle('totp'),
                    paddingLeft: '16px',
                    textAlign: 'center',
                    fontSize: '20px',
                    letterSpacing: '0.2em'
                  }}
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
                style={getButtonStyle()}
                onMouseEnter={() => setIsButtonHovered(true)}
                onMouseLeave={() => setIsButtonHovered(false)}
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
                className="w-full py-2 text-sm hover:underline"
                style={{ color: '#565f89', background: 'transparent', border: 'none', cursor: 'pointer' }}
              >
                Back to login
              </button>
            </div>
          ) : (
            // Normal login / setup form
            <div className="space-y-5">
              <div>
                <label
                  htmlFor="username"
                  className="block text-sm font-medium mb-2"
                  style={{ color: '#c0caf5' }}
                >
                  Username
                </label>
                <div className="relative">
                  <User
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5"
                    style={{ color: '#565f89' }}
                  />
                  <input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onFocus={() => setFocusedField('username')}
                    onBlur={() => setFocusedField(null)}
                    style={getInputStyle('username')}
                    placeholder="Enter username"
                    required
                    autoComplete="username"
                    autoFocus
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="block text-sm font-medium mb-2"
                  style={{ color: '#c0caf5' }}
                >
                  Password
                </label>
                <div className="relative">
                  <Lock
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5"
                    style={{ color: '#565f89' }}
                  />
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setFocusedField('password')}
                    onBlur={() => setFocusedField(null)}
                    style={getInputStyle('password')}
                    placeholder="Enter password"
                    required
                    autoComplete={isSetup ? 'new-password' : 'current-password'}
                  />
                </div>
              </div>

              {isSetup && (
                <div>
                  <label
                    htmlFor="confirmPassword"
                    className="block text-sm font-medium mb-2"
                    style={{ color: '#c0caf5' }}
                  >
                    Confirm Password
                  </label>
                  <div className="relative">
                    <Lock
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5"
                      style={{ color: '#565f89' }}
                    />
                    <input
                      id="confirmPassword"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      onFocus={() => setFocusedField('confirmPassword')}
                      onBlur={() => setFocusedField(null)}
                      style={getInputStyle('confirmPassword')}
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
                style={getButtonStyle()}
                onMouseEnter={() => setIsButtonHovered(true)}
                onMouseLeave={() => setIsButtonHovered(false)}
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
                <p className="text-center text-sm" style={{ color: '#565f89' }}>
                  This will create the initial admin account for OwnPrem.
                </p>
              )}
            </div>
          )}
        </form>

        {/* Footer links */}
        <div className="mt-8 pt-6" style={{ borderTop: '1px solid rgba(122, 162, 247, 0.1)' }}>
          <p className="text-center text-sm" style={{ color: '#565f89' }}>
            Sovereign Bitcoin Infrastructure
          </p>
          <p className="mt-2 text-center">
            <Link
              to="/certificate"
              className="text-sm hover:underline"
              style={{ color: '#7aa2f7' }}
            >
              Certificate setup
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
