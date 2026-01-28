import { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Server, Package, Settings, Wifi, WifiOff, User, LogOut, ChevronUp } from 'lucide-react';
import { useStore } from '../stores/useStore';
import { useAuthStore } from '../stores/useAuthStore';
import { api } from '../api/client';

export default function Layout() {
  const connected = useStore((state) => state.connected);
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [showUserMenu, setShowUserMenu] = useState(false);

  const handleLogout = async () => {
    await api.logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-800 border-r border-gray-700 flex flex-col">
        <div className="p-4 border-b border-gray-700">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <span className="text-bitcoin">N</span>odefoundry
          </h1>
        </div>

        <nav className="p-4 space-y-2 flex-1">
          <NavItem to="/" icon={<LayoutDashboard size={20} />} label="Dashboard" />
          <NavItem to="/servers" icon={<Server size={20} />} label="Servers" />
          <NavItem to="/apps" icon={<Package size={20} />} label="Apps" />
          <NavItem to="/settings" icon={<Settings size={20} />} label="Settings" />
        </nav>

        {/* Connection status */}
        <div className="px-4 py-2 border-t border-gray-700">
          <div className="flex items-center gap-2 text-sm">
            {connected ? (
              <>
                <Wifi size={16} className="text-green-500" />
                <span className="text-gray-400">Connected</span>
              </>
            ) : (
              <>
                <WifiOff size={16} className="text-red-500" />
                <span className="text-gray-400">Disconnected</span>
              </>
            )}
          </div>
        </div>

        {/* User menu */}
        <div className="relative border-t border-gray-700">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="w-full p-4 flex items-center gap-3 hover:bg-gray-700/50 transition-colors"
          >
            <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center">
              <User size={16} className="text-gray-300" />
            </div>
            <div className="flex-1 text-left">
              <p className="text-sm font-medium text-white">{user?.username || 'User'}</p>
              <p className="text-xs text-gray-400">{user?.role || 'admin'}</p>
            </div>
            <ChevronUp
              size={16}
              className={`text-gray-400 transition-transform ${showUserMenu ? '' : 'rotate-180'}`}
            />
          </button>

          {showUserMenu && (
            <div className="absolute bottom-full left-0 right-0 bg-gray-800 border border-gray-700 rounded-t-lg shadow-lg overflow-hidden">
              <button
                onClick={handleLogout}
                className="w-full px-4 py-3 flex items-center gap-3 text-gray-300 hover:bg-gray-700 hover:text-white transition-colors"
              >
                <LogOut size={16} />
                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="p-6">
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
        `flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
          isActive
            ? 'bg-gray-700 text-white'
            : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
        }`
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}
