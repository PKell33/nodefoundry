import { Routes, Route } from 'react-router-dom';
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
const AppsLayout = lazy(() => import('./pages/Apps/AppsLayout'));
const AppsIndex = lazy(() => import('./pages/Apps/index'));
const StorePage = lazy(() => import('./pages/Apps/StorePage'));
const AppDetail = lazy(() => import('./pages/Apps/AppDetail'));
const Storage = lazy(() => import('./pages/Storage'));
const Admin = lazy(() => import('./pages/Admin'));
const MyAccount = lazy(() => import('./pages/MyAccount'));
const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));

// Route loading fallback - shown while lazy components load
function RouteLoadingFallback() {
  return (
    <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center">
      <PageLoadingSpinner message="Loading..." />
    </div>
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

            {/* Apps routes with shared layout for breadcrumb */}
            <Route path="apps" element={<PageErrorBoundary><AppsLayout /></PageErrorBoundary>}>
              <Route index element={<AppsIndex />} />
              {/* Dynamic store page - handles umbrel, start9, casaos, runtipi */}
              <Route path=":store" element={<StorePage />} />
              <Route path=":store/:registry" element={<StorePage />} />
              <Route path=":store/:registry/:appId" element={<AppDetail />} />
            </Route>

            <Route path="storage" element={<PageErrorBoundary><Storage /></PageErrorBoundary>} />
            <Route path="account" element={<PageErrorBoundary><MyAccount /></PageErrorBoundary>} />
            <Route path="admin" element={<PageErrorBoundary><Admin /></PageErrorBoundary>} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

export default App;
