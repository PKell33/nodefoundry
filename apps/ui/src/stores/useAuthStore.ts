import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UserGroupMembership {
  groupId: string;
  groupName: string;
  role: 'admin' | 'operator' | 'viewer';
  totpRequired: boolean;
}

interface User {
  userId: string;
  username: string;
  isSystemAdmin: boolean;
  groups: UserGroupMembership[];
  totpEnabled?: boolean;
  totpRequired?: boolean;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  totpSetupRequired: boolean;

  // Actions
  setTokens: (accessToken: string, refreshToken: string) => void;
  setUser: (user: User) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  setTotpSetupRequired: (required: boolean) => void;
  logout: () => void;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      totpSetupRequired: false,

      setTokens: (accessToken, refreshToken) =>
        set({
          accessToken,
          refreshToken,
          isAuthenticated: true,
          error: null,
        }),

      setUser: (user) => set({ user }),

      setError: (error) => set({ error, isLoading: false }),

      setLoading: (isLoading) => set({ isLoading }),

      setTotpSetupRequired: (required) => set({ totpSetupRequired: required }),

      logout: () =>
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          isAuthenticated: false,
          error: null,
          totpSetupRequired: false,
        }),

      clearError: () => set({ error: null }),
    }),
    {
      name: 'ownprem-auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        totpSetupRequired: state.totpSetupRequired,
      }),
    }
  )
);
