import { create } from "zustand";

/** Visibility of editor overlay panels (currently the Microflow devtools). */
type UiPanelState = {
  devtoolsOpen: boolean;
  toggleDevtools: () => void;
  setDevtoolsOpen: (open: boolean) => void;
};

export const useUiPanelStore = create<UiPanelState>((set) => ({
  devtoolsOpen: false,
  toggleDevtools: () => set((state) => ({ devtoolsOpen: !state.devtoolsOpen })),
  setDevtoolsOpen: (open) => set({ devtoolsOpen: open }),
}));
