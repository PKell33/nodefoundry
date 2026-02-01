import { create } from 'zustand';

interface AppState {
  connected: boolean;
  setConnected: (connected: boolean) => void;
}

export const useStore = create<AppState>((set) => ({
  connected: false,
  setConnected: (connected) => set({ connected }),
}));
