// The LLM provider settings, and where they settle.
//
// The settings form writes a field at every keystroke, so `providers` holds
// what is typed. A request made to check a provider (the status probe, the
// model list) is made from `settled` instead, which follows `providers` once
// the typing has stopped: `PROVIDER_SETTINGS_SETTLE_MS` after the last edit of
// that provider, or when something asks for it sooner (`settleLlmProviders`).
// So a key or an endpoint being typed is not sent to the provider a keystroke
// at a time. A provider that is added or removed, and another default, are not
// typing: they are settled at once. The broker settings settle the same way
// (`cloud/mqtt-broker.ts`).

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { realTimers, type Timers } from "@/lib/timers";

export type LlmProviderConfig = {
  id: string;
  name: string;
  /** Which transport reaches this provider. `"http"` (the default, and what
   *  every configuration saved before local CLIs existed is) means an
   *  OpenAI-compatible endpoint at `baseUrl`. `"cli"` means a local agent CLI,
   *  named by `baseUrl` — see `ai/cli-providers.ts`; desktop only. */
  kind?: "http" | "cli";
  /** The endpoint, or for a `"cli"` provider the CLI's id. */
  baseUrl: string;
  apiKey: string;
  /** The model this configuration talks to. Set here rather than at each place
   *  that asks — a configuration is an endpoint plus what to say to it. */
  model: string;
  isDefault: boolean;
};

export type ProviderStatus = "idle" | "testing" | "ok" | "error";

/**
 * How long a provider's settings must have gone unedited before they settle:
 * longer than the gap between two keystrokes, short enough for the status to
 * answer as the hands leave the keyboard. The broker settings wait as long.
 */
export const PROVIDER_SETTINGS_SETTLE_MS = 500;

type LlmProviderStore = {
  /** The settings as typed: what the settings form shows. */
  providers: LlmProviderConfig[];
  /** The settings as they settled: what a provider is checked with. The same
   *  list (reference) until a change settles. */
  settled: LlmProviderConfig[];
  statuses: Record<string, ProviderStatus>;
  /** Settled at once. */
  addProvider: (p: Omit<LlmProviderConfig, "id">) => string;
  /** What the settings form does at a keystroke: shown in `providers` at
   *  once, settled {@link PROVIDER_SETTINGS_SETTLE_MS} after the last call for
   *  this provider. */
  updateProvider: (id: string, p: Partial<Omit<LlmProviderConfig, "id">>) => void;
  /** Settled at once, with whatever was typed for the others. Its status
   *  goes with it. */
  deleteProvider: (id: string) => void;
  /** Settled at once, with whatever was typed for the others. */
  setDefaultProvider: (id: string) => void;
  /** Settle what is typed now, without waiting. Nothing changes when nothing
   *  is typed. */
  settle: () => void;
  getProvider: (id: string) => LlmProviderConfig | undefined;
  setStatus: (id: string, status: ProviderStatus) => void;
};

const uid = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

/**
 * A store of LLM provider settings. The app has one ({@link useLlmProviderStore}).
 *
 * `timers` is what the settle wait runs on, and `storage` where the settings
 * are kept: `setTimeout` and `localStorage` when left out. A test passes
 * virtual time and a storage of its own. The storage holds the settings as
 * typed; a store that loads them starts with them settled.
 */
export function createLlmProviderStore(options: { timers?: Timers; storage?: StateStorage } = {}) {
  const timers = options.timers ?? realTimers;
  const { storage } = options;
  /** The one settle wait: running while something is typed. */
  let wait: unknown;
  const endWait = () => {
    if (wait === undefined) return;
    timers.clear(wait);
    wait = undefined;
  };

  return create<LlmProviderStore>()(
    persist(
      (set, get) => {
        /** Make `providers` what they are and settle them, in one change. */
        const settleWith = (providers: LlmProviderConfig[]) => {
          endWait();
          set({ providers, settled: providers });
        };
        return {
          providers: [],
          settled: [],
          statuses: {},

          addProvider: (p) => {
            const id = uid();
            const isFirst = get().providers.length === 0;
            settleWith([...get().providers, { ...p, id, isDefault: isFirst || p.isDefault }]);
            return id;
          },

          updateProvider: (id, updates) => {
            set((s) => ({ providers: s.providers.map((p) => (p.id === id ? { ...p, ...updates } : p)) }));
            endWait();
            wait = timers.set(() => get().settle(), PROVIDER_SETTINGS_SETTLE_MS);
          },

          deleteProvider: (id) => {
            const filtered = get().providers.filter((p) => p.id !== id);
            if (filtered.length > 0 && !filtered.some((p) => p.isDefault)) {
              filtered[0] = { ...filtered[0], isDefault: true };
            }
            settleWith(filtered);
            // Its status goes with it: a probe that answers late has nothing
            // to bring back.
            const { [id]: _status, ...statuses } = get().statuses;
            set({ statuses });
          },

          setDefaultProvider: (id) => {
            settleWith(get().providers.map((p) => ({ ...p, isDefault: p.id === id })));
          },

          settle: () => {
            endWait();
            if (get().settled !== get().providers) set({ settled: get().providers });
          },

          getProvider: (id) => get().providers.find((p) => p.id === id),

          setStatus: (id, status) => set((s) => ({ statuses: { ...s.statuses, [id]: status } })),
        };
      },
      {
        name: "microflow-llm-providers",
        ...(storage ? { storage: createJSONStorage(() => storage) } : {}),
        partialize: (s) => ({ providers: s.providers }),
        // What is loaded was typed before: it has settled.
        merge: (persisted, current) => {
          const providers = (persisted as { providers?: LlmProviderConfig[] } | undefined)?.providers;
          return providers ? { ...current, providers, settled: providers } : current;
        },
      },
    ),
  );
}

export const useLlmProviderStore = createLlmProviderStore();

/** Settle the provider settings that are typed now: for whatever must not act
 *  on older settings than the form shows (a console command). */
export function settleLlmProviders(): void {
  useLlmProviderStore.getState().settle();
}

/** Whether a request to `is` goes elsewhere, or with another key, than one to `was`. */
export const reachesDifferently = (was: LlmProviderConfig, is: LlmProviderConfig): boolean =>
  (was.kind ?? "http") !== (is.kind ?? "http") || was.baseUrl !== is.baseUrl || was.apiKey !== is.apiKey;

export function useProviderStatus(providerId: string) {
  return useLlmProviderStore((s) => s.statuses[providerId] ?? "idle");
}
