import { useState, useEffect } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Server, Package, Settings, Wifi, WifiOff, User, Menu, X, Sun, Moon, HardDrive, Shield, LogOut, UserCircle, ChevronUp } from 'lucide-react';
import { useStore } from '../stores/useStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useThemeStore } from '../stores/useThemeStore';
import { api } from '../api/client';

export default function Layout() {
  const connected = useStore((state) => state.connected);
  // Use selectors to avoid subscribing to entire store state
  const user = useAuthStore((state) => state.user);
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const navigate = useNavigate();
  const location = useLocation();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleLogout = async () => {
    await api.logout();
    navigate('/login');
  };

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

  return (
    <div className="min-h-screen flex">
      {/* Mobile overlay - backdrop for sidebar */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
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
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h1 className="text-xl font-extrabold tracking-tight">
            <span>&#x232C;</span><span style={{ color: '#7aa2f7' }}>w</span><span>nPrem</span>
          </h1>
          {/* Mobile close button */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
            aria-label="Close sidebar"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <nav className="p-4 space-y-2 flex-1 overflow-y-auto">
          <NavItem to="/" icon={<LayoutDashboard size={20} />} label="Dashboard" />
          <NavItem to="/servers" icon={<Server size={20} />} label="Servers" />
          <NavItem to="/apps" icon={<Package size={20} />} label="Apps" />
          <NavItem to="/storage" icon={<HardDrive size={20} />} label="Storage" />
          <NavItem to="/settings" icon={<Settings size={20} />} label="Settings" />
          {user?.isSystemAdmin && (
            <NavItem to="/admin" icon={<Shield size={20} />} label="Admin" />
          )}
        </nav>

        {/* Theme toggle */}
        <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={toggleTheme}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors
              text-gray-600 hover:text-gray-900 hover:bg-gray-200/50 dark:text-gray-400 dark:hover:text-white dark:hover:bg-gray-700/50"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
          </button>
        </div>

        {/* Connection status */}
        <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 text-sm">
            {connected ? (
              <>
                <Wifi size={16} className="text-green-500" />
                <span className="text-gray-500 dark:text-gray-400">Connected</span>
              </>
            ) : (
              <>
                <WifiOff size={16} className="text-red-500" />
                <span className="text-gray-500 dark:text-gray-400">Disconnected</span>
              </>
            )}
          </div>
        </div>

        {/* User menu */}
        <div className="relative border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            aria-expanded={showUserMenu}
            aria-haspopup="menu"
            aria-label="User menu"
            className="w-full p-4 flex items-center gap-3 transition-colors
              hover:bg-gray-200/50 dark:hover:bg-gray-700/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
          >
            <div className="w-8 h-8 bg-gray-300 dark:bg-gray-600 rounded-full flex items-center justify-center">
              <User size={16} className="text-gray-600 dark:text-gray-300" aria-hidden="true" />
            </div>
            <div className="flex-1 text-left">
              <p className="text-sm font-medium">{user?.username || 'User'}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {user?.isSystemAdmin ? 'System Admin' : user?.groups?.[0]?.role || 'User'}
              </p>
            </div>
            <ChevronUp
              size={16}
              className={`text-gray-500 dark:text-gray-400 transition-transform ${showUserMenu ? '' : 'rotate-180'}`}
              aria-hidden="true"
            />
          </button>

          {showUserMenu && (
            <div
              role="menu"
              aria-label="User options"
              className="absolute bottom-full left-0 right-0 rounded-t-lg shadow-lg overflow-hidden
                bg-white border border-gray-200 dark:bg-gray-800 dark:border-gray-700"
            >
              <NavLink
                to="/account"
                onClick={() => setShowUserMenu(false)}
                role="menuitem"
                className="w-full px-4 py-3 flex items-center gap-3 transition-colors
                  text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white"
              >
                <UserCircle size={16} aria-hidden="true" />
                <span>My Account</span>
              </NavLink>
              <button
                onClick={handleLogout}
                role="menuitem"
                className="w-full px-4 py-3 flex items-center gap-3 transition-colors border-t border-gray-200 dark:border-gray-700
                  text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white"
              >
                <LogOut size={16} aria-hidden="true" />
                <span>Sign Out</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto min-w-0 md:ml-64">
        {/* Mobile header */}
        <div className="md:hidden sticky top-0 z-30 p-4 border-b
          bg-white border-gray-200 dark:bg-gray-900 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-lg transition-colors
                hover:bg-gray-100 dark:hover:bg-gray-800"
              aria-label="Open menu"
              aria-expanded={sidebarOpen}
            >
              <Menu size={24} aria-hidden="true" />
            </button>
            <h1 className="text-lg font-extrabold tracking-tight">
              <span>&#x232C;</span><span style={{ color: '#7aa2f7' }}>w</span><span>nPrem</span>
            </h1>
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg transition-colors
                hover:bg-gray-100 dark:hover:bg-gray-800"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun size={20} aria-hidden="true" /> : <Moon size={20} aria-hidden="true" />}
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
