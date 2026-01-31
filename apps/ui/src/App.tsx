import { Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, Suspense, lazy } from 'react';
import Layout from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { useWebSocket } from './hooks/useWebSocket';
import { useAuthStore } from './stores/useAuthStore';
import { Toaster } from './components/Toaster';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PageErrorBoundary } from './components/PageErrorBoundary';
import { PageLoadingSpinner } from './components/LoadingSpinner';

// Lazy load page components for code splitting
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Servers = lazy(() => import('./pages/Servers'));
const Apps = lazy(() => import('./pages/Apps'));
const Storage = lazy(() => import('./pages/Storage'));
const Settings = lazy(() => import('./pages/Settings'));
const Admin = lazy(() => import('./pages/Admin'));
const MyAccount = lazy(() => import('./pages/MyAccount'));
const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const TotpSetup = lazy(() => import('./pages/TotpSetup').then(m => ({ default: m.TotpSetup })));
const CertificateSetup = lazy(() => import('./pages/CertificateSetup').then(m => ({ default: m.CertificateSetup })));

// Route loading fallback - shown while lazy components load
function RouteLoadingFallback() {
  return (
    <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center">
      <PageLoadingSpinner message="Loading..." />
    </div>
  );
}

// Route that requires authentication but allows users who need TOTP setup
function TotpSetupRoute() {
  const { isAuthenticated, totpSetupRequired } = useAuthStore();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // If TOTP setup is not required, redirect to home
  if (!totpSetupRequired) {
    return <Navigate to="/" replace />;
  }

  return (
    <Suspense fallback={<RouteLoadingFallback />}>
      <TotpSetup />
    </Suspense>
  );
}

function App() {
  const { connect, disconnect } = useWebSocket();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  useEffect(() => {
    if (isAuthenticated) {
      connect();
    } else {
      disconnect();
    }
  }, [isAuthenticated, connect, disconnect]);

  return (
    <ErrorBoundary>
      <Toaster />
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/certificate" element={<CertificateSetup />} />
          <Route path="/setup-2fa" element={<TotpSetupRoute />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<PageErrorBoundary><Dashboard /></PageErrorBoundary>} />
            <Route path="servers" element={<PageErrorBoundary><Servers /></PageErrorBoundary>} />
            <Route path="apps" element={<PageErrorBoundary><Apps /></PageErrorBoundary>} />
            <Route path="storage" element={<PageErrorBoundary><Storage /></PageErrorBoundary>} />
            <Route path="account" element={<PageErrorBoundary><MyAccount /></PageErrorBoundary>} />
            <Route path="settings" element={<PageErrorBoundary><Settings /></PageErrorBoundary>} />
            <Route path="admin" element={<PageErrorBoundary><Admin /></PageErrorBoundary>} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

export default App;
