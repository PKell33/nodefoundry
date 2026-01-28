import { Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Servers from './pages/Servers';
import Apps from './pages/Apps';
import Settings from './pages/Settings';
import { Login } from './pages/Login';
import { ProtectedRoute } from './components/ProtectedRoute';
import { useWebSocket } from './hooks/useWebSocket';
import { useAuthStore } from './stores/useAuthStore';

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
