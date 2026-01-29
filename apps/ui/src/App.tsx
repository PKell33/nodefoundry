import { Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Servers from './pages/Servers';
import Apps from './pages/Apps';
import Settings from './pages/Settings';
import { Login } from './pages/Login';
import { TotpSetup } from './pages/TotpSetup';
import { CertificateSetup } from './pages/CertificateSetup';
import { ProtectedRoute } from './components/ProtectedRoute';
import { useWebSocket } from './hooks/useWebSocket';
import { useAuthStore } from './stores/useAuthStore';

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

  return <TotpSetup />;
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
        <Route index element={<Dashboard />} />
        <Route path="servers" element={<Servers />} />
        <Route path="apps" element={<Apps />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}

export default App;
