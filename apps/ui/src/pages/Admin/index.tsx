import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/useAuthStore';
import { ComponentErrorBoundary } from '../../components/ComponentErrorBoundary';
import AdminTabs from './AdminTabs';
import UserManagement from './sections/UserManagement';
import type { TabId } from './types';

/**
 * Admin page - User management.
 * Only accessible by system administrators.
 */
export default function Admin() {
  const { user: currentUser } = useAuthStore();
  const [activeTab, setActiveTab] = useState<TabId>('users');

  // Redirect non-admins
  if (!currentUser?.isSystemAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold mb-2">Administration</h1>
        <p className="text-muted">Manage users</p>
      </div>

      <AdminTabs activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Tab Content - wrapped in error boundaries */}
      {activeTab === 'users' && (
        <ComponentErrorBoundary componentName="User Management">
          <UserManagement currentUserId={currentUser?.userId} />
        </ComponentErrorBoundary>
      )}
    </div>
  );
}
