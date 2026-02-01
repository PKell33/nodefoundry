import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UserGroupMembership {
  groupId: string;
  groupName: string;
  role: 'admin' | 'operator' | 'viewer';
}

interface User {
  userId: string;
  username: string;
  isSystemAdmin: boolean;
  groups: UserGroupMembership[];
}

interface AuthState {
  // User info only - tokens are now stored in httpOnly cookies (not accessible to JS)
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  setAuthenticated: (user: User) => void;
  setUser: (user: User) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  logout: () => void;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      setAuthenticated: (user) =>
        set({
          user,
          isAuthenticated: true,
          error: null,
        }),

      setUser: (user) => set({ user }),

      setError: (error) => set({ error, isLoading: false }),

      setLoading: (isLoading) => set({ isLoading }),

      logout: () =>
        set({
          user: null,
          isAuthenticated: false,
          error: null,
        }),

      clearError: () => set({ error: null }),
    }),
    {
      name: 'ownprem-auth',
      // Only persist user info and auth state - tokens are in httpOnly cookies
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
