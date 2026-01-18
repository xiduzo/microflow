import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ActiveFlowStore = {
  activeFlowId: string;
  setActiveFlowId: (id: string | null) => void;
};

export const useActiveFlowStore = create<ActiveFlowStore>()(
  persist(
    (set, get) => ({
      activeFlowId: "local",
      setActiveFlowId: (id) => {
        // Only default to "local" if there's no current active flow
        // This preserves cloud flows when navigating away
        if (id === null) {
          return; // Don't change the active flow when explicitly set to null
        }
        set({ activeFlowId: id });
      },
    }),
    { name: "microflow-active-flow" },
  ),
);
