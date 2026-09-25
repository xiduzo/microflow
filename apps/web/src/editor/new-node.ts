import { create } from "zustand";

type NewNodeState = {
  open: boolean;
  nodeToAdd: string | null;
  setOpen: (open: boolean) => void;
  setNodeToAdd: (nodeId: string | null) => void;
};

export const useNewNodeStore = create<NewNodeState>((set) => ({
  open: false,
  nodeToAdd: null,
  setOpen: (open) => set({ open }),
  setNodeToAdd: (nodeId) => set({ nodeToAdd: nodeId }),
}));
