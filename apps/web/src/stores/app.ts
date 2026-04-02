import { create } from "zustand";
import { persist } from "zustand/middleware";

type AppState = {
  // Sidebar
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;

  // First Arduino connection celebration
  hasConnectedArduino: boolean;
  showConfetti: boolean;
  markArduinoConnected: () => void;
  dismissConfetti: () => void;
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      hasConnectedArduino: false,
      showConfetti: false,
      markArduinoConnected: () => set({ hasConnectedArduino: true, showConfetti: true }),
      dismissConfetti: () => set({ showConfetti: false }),
    }),
    {
      name: "microflow:app",
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        hasConnectedArduino: state.hasConnectedArduino,
      }),
    },
  ),
);
