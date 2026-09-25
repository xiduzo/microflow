import { create } from "zustand";
import { persist } from "zustand/middleware";

import { splitFromLegacyApp } from "@/shell/legacy-app-store";

type SidebarState = {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
    }),
    {
      name: "microflow:sidebar",
      storage: splitFromLegacyApp(["sidebarOpen"]),
      partialize: (state) => ({ sidebarOpen: state.sidebarOpen }),
    },
  ),
);
