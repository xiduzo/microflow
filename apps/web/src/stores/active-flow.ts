import { create } from "zustand";
import { persist } from "zustand/middleware";

import { splitFromLegacyApp } from "./legacy-app-store";

type ActiveFlowState = {
  activeFlowId: string;
  setActiveFlowId: (id: string | null) => void;
};

export const useActiveFlowStore = create<ActiveFlowState>()(
  persist(
    (set) => ({
      activeFlowId: "local",
      setActiveFlowId: (id) => {
        if (id === null) return;
        set({ activeFlowId: id });
      },
    }),
    {
      // Not `microflow-active-flow`: an earlier store left a stale value there,
      // which would win over the one being taken from the legacy key.
      name: "microflow:active-flow",
      storage: splitFromLegacyApp(["activeFlowId"]),
      partialize: (state) => ({ activeFlowId: state.activeFlowId }),
    },
  ),
);
