import { create } from "zustand";
import { persist } from "zustand/middleware";

export type LlmProviderConfig = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  isDefault: boolean;
};

export type ProviderStatus = "idle" | "testing" | "ok" | "error";

type LlmProviderStore = {
  providers: LlmProviderConfig[];
  statuses: Record<string, ProviderStatus>;
  addProvider: (p: Omit<LlmProviderConfig, "id">) => string;
  updateProvider: (id: string, p: Partial<Omit<LlmProviderConfig, "id">>) => void;
  deleteProvider: (id: string) => void;
  setDefaultProvider: (id: string) => void;
  getProvider: (id: string) => LlmProviderConfig | undefined;
  setStatus: (id: string, status: ProviderStatus) => void;
};

const uid = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

export const useLlmProviderStore = create<LlmProviderStore>()(
  persist(
    (set, get) => ({
      providers: [],
      statuses: {},

      addProvider: (p) => {
        const id = uid();
        const isFirst = get().providers.length === 0;
        set((s) => ({ providers: [...s.providers, { ...p, id, isDefault: isFirst || p.isDefault }] }));
        return id;
      },

      updateProvider: (id, updates) => {
        set((s) => ({ providers: s.providers.map((p) => (p.id === id ? { ...p, ...updates } : p)) }));
      },

      deleteProvider: (id) => {
        set((s) => {
          const filtered = s.providers.filter((p) => p.id !== id);
          if (filtered.length > 0 && !filtered.some((p) => p.isDefault)) filtered[0].isDefault = true;
          return { providers: filtered };
        });
      },

      setDefaultProvider: (id) => {
        set((s) => ({ providers: s.providers.map((p) => ({ ...p, isDefault: p.id === id })) }));
      },

      getProvider: (id) => get().providers.find((p) => p.id === id),

      setStatus: (id, status) => set((s) => ({ statuses: { ...s.statuses, [id]: status } })),
    }),
    { name: "microflow-llm-providers", partialize: (s) => ({ providers: s.providers }) }
  )
);
