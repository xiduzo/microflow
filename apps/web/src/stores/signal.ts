import { create } from "zustand";
import { useShallow } from "zustand/shallow";

export type Signal = {
  id: string;
  edgeId: string;
  startTime: number;
};

export const SIGNAL_DURATION = 150;
export type SignalState = {
  signals: Map<string, Signal[]>;
  addSignal: (edgeId: string) => void;
  removeSignal: (edgeId: string, signalId: string) => void;
  getEdgeSignals: (edgeId: string) => Signal[];
  clearSignals: () => void;
  clearEdgeSignals: (edgeId: string) => void;
};

/** Shared by every signal id; cheaper and more collision-proof than the
 *  `Date.now()` + `Math.random()` string this used to build per signal. */
let signalCounter = 0;

/** One shared empty array, so an idle edge's selector keeps a stable reference
 *  and never re-renders on another edge's signal. */
const EMPTY_SIGNALS: Signal[] = [];

/**
 * Signals added since the last publish, and the frame callback that will publish
 * them. A single flow turn can fire dozens of signals; batching means one `Map`
 * rebuild and one re-render per frame rather than per signal.
 */
let pendingAdds: Signal[] = [];
let addHandle: number | null = null;
/** Set while a sweep is scheduled, so expiry costs one timer for the whole
 *  store rather than one `setTimeout` per signal. */
let sweepHandle: ReturnType<typeof setTimeout> | null = null;

const raf = (callback: () => void): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : (setTimeout(callback, 16) as unknown as number);

const cancelRaf = (handle: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
};

export const useSignalStore = create<SignalState>((set, get) => {
  /** Drop every signal past its animation window, in one pass over the store. */
  const sweep = (): void => {
    sweepHandle = null;
    const cutoff = Date.now() - SIGNAL_DURATION;
    const current = get().signals;
    if (current.size === 0) return;

    let changed = false;
    const next = new Map<string, Signal[]>();
    for (const [edgeId, signals] of current) {
      const live = signals.filter((signal) => signal.startTime > cutoff);
      if (live.length !== signals.length) changed = true;
      if (live.length > 0) next.set(edgeId, live);
    }
    if (changed) set({ signals: next });
    if (next.size > 0) scheduleSweep();
  };

  function scheduleSweep(): void {
    if (sweepHandle !== null) return;
    sweepHandle = setTimeout(sweep, SIGNAL_DURATION + 10);
  }

  const flushAdds = (): void => {
    addHandle = null;
    const batch = pendingAdds;
    pendingAdds = [];
    if (batch.length === 0) return;

    set((state) => {
      const next = new Map(state.signals);
      for (const signal of batch) {
        const existing = next.get(signal.edgeId);
        next.set(signal.edgeId, existing ? [...existing, signal] : [signal]);
      }
      return { signals: next };
    });
    scheduleSweep();
  };

  return {
    signals: new Map(),

    addSignal: (edgeId: string) => {
      signalCounter += 1;
      pendingAdds.push({ id: `${edgeId}-${signalCounter}`, edgeId, startTime: Date.now() });
      if (addHandle === null) addHandle = raf(flushAdds);
    },

    removeSignal: (edgeId: string, signalId: string) => {
      set((state) => {
        const existing = state.signals.get(edgeId);
        if (!existing) return state;
        const filtered = existing.filter((signal) => signal.id !== signalId);
        if (filtered.length === existing.length) return state;

        const newSignals = new Map(state.signals);
        if (filtered.length === 0) newSignals.delete(edgeId);
        else newSignals.set(edgeId, filtered);
        return { signals: newSignals };
      });
    },

    getEdgeSignals: (edgeId: string) => {
      return get().signals.get(edgeId) ?? EMPTY_SIGNALS;
    },

    clearSignals: () => {
      pendingAdds = [];
      if (addHandle !== null) {
        cancelRaf(addHandle);
        addHandle = null;
      }
      set({ signals: new Map() });
    },

    clearEdgeSignals: (edgeId: string) => {
      set((state) => {
        if (!state.signals.has(edgeId)) return state;
        const newSignals = new Map(state.signals);
        newSignals.delete(edgeId);
        return { signals: newSignals };
      });
    },
  };
});

export function useEdgeSignals(edgeId: string) {
  return useSignalStore(useShallow((state) => state.signals.get(edgeId) ?? EMPTY_SIGNALS));
}

export function useSignalActions() {
  return useSignalStore(
    useShallow((state) => ({
      addSignal: state.addSignal,
      removeSignal: state.removeSignal,
      clearSignals: state.clearSignals,
      clearEdgeSignals: state.clearEdgeSignals,
    })),
  );
}
