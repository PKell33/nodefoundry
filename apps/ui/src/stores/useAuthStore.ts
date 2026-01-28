import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  userId: string;
  username: string;
  role: string;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  setTokens: (accessToken: string, refreshToken: string) => void;
  setUser: (user: User) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
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

      logout: () =>
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          isAuthenticated: false,
          error: null,
        }),

      clearError: () => set({ error: null }),
    }),
    {
      name: 'nodefoundry-auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
