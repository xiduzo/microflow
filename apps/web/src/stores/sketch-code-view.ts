import { create } from "zustand";

type SketchCodeViewState = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

/** Toggle state for the read-only generated-sketch Code view (Task #45). */
export const useSketchCodeViewStore = create<SketchCodeViewState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
