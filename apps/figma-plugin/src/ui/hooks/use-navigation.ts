import { create } from "zustand";

export type Page = "home" | "mqtt" | "variables";

type NavigationStore = {
  page: Page;
  history: Page[];
  navigate: (page: Page) => void;
  goBack: () => void;
  canGoBack: boolean;
};

export const useNavigation = create<NavigationStore>((set, get) => ({
  page: "home",
  history: [],
  canGoBack: false,
  navigate: (page) =>
    set((state) => ({
      page,
      history: [...state.history, state.page],
      canGoBack: true,
    })),
  goBack: () => {
    const { history } = get();
    const prev = history[history.length - 1] ?? "home";
    set({
      page: prev,
      history: history.slice(0, -1),
      canGoBack: history.length > 1,
    });
  },
}));
