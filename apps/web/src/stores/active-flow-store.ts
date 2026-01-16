import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ActiveFlowStore = {
  activeFlowId: string;
  setActiveFlowId: (id: string) => void;
};

export const useActiveFlowStore = create<ActiveFlowStore>()(
  persist(
    (set) => ({
      activeFlowId: "local",
      setActiveFlowId: (id) => set({ activeFlowId: id }),
    }),
    { name: "microflow-active-flow" }
  )
);
