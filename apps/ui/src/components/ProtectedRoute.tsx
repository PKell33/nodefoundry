import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../stores/useAuthStore';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { isAuthenticated, totpSetupRequired } = useAuthStore();
  const location = useLocation();

  if (!isAuthenticated) {
    // Redirect to login, but save the attempted location
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // If TOTP setup is required, redirect to setup page
  if (totpSetupRequired) {
    return <Navigate to="/setup-2fa" replace />;
  }

  return <>{children}</>;
}
