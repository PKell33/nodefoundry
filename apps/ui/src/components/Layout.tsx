import { useState, useEffect } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Server, Package, Settings, Wifi, WifiOff, User, LogOut, ChevronUp, Menu, X, Sun, Moon } from 'lucide-react';
import { useStore } from '../stores/useStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useThemeStore } from '../stores/useThemeStore';
import { api } from '../api/client';

export default function Layout() {
  const connected = useStore((state) => state.connected);
  const { user } = useAuthStore();
  const { theme, toggleTheme } = useThemeStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Close sidebar on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSidebarOpen(false);
        setShowUserMenu(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  const handleLogout = async () => {
    await api.logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen flex">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50
          w-64 h-screen sidebar flex flex-col
          transform transition-transform duration-200 ease-in-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
      >
        <div className="p-4 border-b border-gray-700 dark:border-gray-700 light:border-gray-200 flex items-center justify-between">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <span className="text-bitcoin">N</span>odefoundry
          </h1>
          {/* Mobile close button */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden p-1 rounded hover:bg-gray-700 dark:hover:bg-gray-700 light:hover:bg-gray-200"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="p-4 space-y-2 flex-1 overflow-y-auto">
          <NavItem to="/" icon={<LayoutDashboard size={20} />} label="Dashboard" />
          <NavItem to="/servers" icon={<Server size={20} />} label="Servers" />
          <NavItem to="/apps" icon={<Package size={20} />} label="Apps" />
          <NavItem to="/settings" icon={<Settings size={20} />} label="Settings" />
        </nav>

        {/* Theme toggle */}
        <div className="px-4 py-2 border-t border-gray-700 dark:border-gray-700 light:border-gray-200">
          <button
            onClick={toggleTheme}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors
              dark:text-gray-400 dark:hover:text-white dark:hover:bg-gray-700/50
              light:text-gray-600 light:hover:text-gray-900 light:hover:bg-gray-200/50"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
          </button>
        </div>

        {/* Connection status */}
        <div className="px-4 py-2 border-t border-gray-700 dark:border-gray-700 light:border-gray-200">
          <div className="flex items-center gap-2 text-sm">
            {connected ? (
              <>
                <Wifi size={16} className="text-green-500" />
                <span className="dark:text-gray-400 light:text-gray-500">Connected</span>
              </>
            ) : (
              <>
                <WifiOff size={16} className="text-red-500" />
                <span className="dark:text-gray-400 light:text-gray-500">Disconnected</span>
              </>
            )}
          </div>
        </div>

        {/* User menu */}
        <div className="relative border-t border-gray-700 dark:border-gray-700 light:border-gray-200">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="w-full p-4 flex items-center gap-3 transition-colors
              dark:hover:bg-gray-700/50 light:hover:bg-gray-200/50"
          >
            <div className="w-8 h-8 bg-gray-600 dark:bg-gray-600 light:bg-gray-300 rounded-full flex items-center justify-center">
              <User size={16} className="dark:text-gray-300 light:text-gray-600" />
            </div>
            <div className="flex-1 text-left">
              <p className="text-sm font-medium">{user?.username || 'User'}</p>
              <p className="text-xs dark:text-gray-400 light:text-gray-500">
                {user?.isSystemAdmin ? 'System Admin' : user?.groups?.[0]?.role || 'User'}
              </p>
            </div>
            <ChevronUp
              size={16}
              className={`dark:text-gray-400 light:text-gray-500 transition-transform ${showUserMenu ? '' : 'rotate-180'}`}
            />
          </button>

          {showUserMenu && (
            <div className="absolute bottom-full left-0 right-0 rounded-t-lg shadow-lg overflow-hidden
              dark:bg-gray-800 dark:border dark:border-gray-700
              light:bg-white light:border light:border-gray-200">
              <button
                onClick={handleLogout}
                className="w-full px-4 py-3 flex items-center gap-3 transition-colors
                  dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white
                  light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900"
              >
                <LogOut size={16} />
                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto min-w-0 md:ml-64">
        {/* Mobile header */}
        <div className="md:hidden sticky top-0 z-30 p-4 border-b
          dark:bg-gray-900 dark:border-gray-700
          light:bg-white light:border-gray-200">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-lg transition-colors
                dark:hover:bg-gray-800 light:hover:bg-gray-100"
            >
              <Menu size={24} />
            </button>
            <h1 className="text-lg font-bold flex items-center gap-2">
              <span className="text-bitcoin">N</span>odefoundry
            </h1>
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg transition-colors
                dark:hover:bg-gray-800 light:hover:bg-gray-100"
            >
              {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
            </button>
          </div>
        </div>

        <div className="p-4 md:p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function NavItem({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `nav-item ${isActive ? 'active' : ''}`
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}
