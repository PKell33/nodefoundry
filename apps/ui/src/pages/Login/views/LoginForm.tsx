import { Lock, User } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginFormSchema, type LoginFormData } from '../../../lib/validation';
import { api } from '../../../api/client';
import { useAuthStore } from '../../../stores/useAuthStore';
import AuthInput from '../components/AuthInput';
import AuthButton from '../components/AuthButton';

interface LoginFormProps {
  onSetupRequired: () => void;
  onSuccess: (redirectTo: string) => void;
}

export default function LoginForm({ onSetupRequired, onSuccess }: LoginFormProps) {
  const { setAuthenticated, setError, setLoading, isLoading, clearError } = useAuthStore();

  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginFormSchema),
    mode: 'onBlur',
    defaultValues: { username: '', password: '' },
  });

  const handleSubmit = async (data: LoginFormData) => {
    clearError();
    setLoading(true);

    try {
      const response = await api.login(data.username, data.password);
      if (response.user) {
        setAuthenticated(response.user);
        onSuccess('/');
      }
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('No users exist') || err.message.includes('setup')) {
          onSetupRequired();
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

  return (
    <form onSubmit={form.handleSubmit(handleSubmit)}>
      <div className="space-y-5">
        <AuthInput
          id="login-username"
          label="Username"
          icon={<User className="w-5 h-5" aria-hidden="true" />}
          placeholder="Enter username"
          autoComplete="username"
          autoFocus
          aria-required={true}
          error={form.formState.errors.username?.message}
          errorId="login-username-error"
          {...form.register('username')}
        />

        <AuthInput
          id="login-password"
          label="Password"
          icon={<Lock className="w-5 h-5" aria-hidden="true" />}
          type="password"
          placeholder="Enter password"
          autoComplete="current-password"
          aria-required={true}
          error={form.formState.errors.password?.message}
          errorId="login-password-error"
          {...form.register('password')}
        />

        <AuthButton isLoading={isLoading} loadingText="Signing in...">
          Sign In
        </AuthButton>
      </div>
    </form>
  );
}
