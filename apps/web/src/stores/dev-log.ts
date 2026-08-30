import { create } from "zustand";

export type DevLogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** One unified log/event entry shown in the Microflow devtools. */
export type DevLogEntry = {
  id: string;
  timestamp: number;
  level: DevLogLevel;
  /** Category — `flow`, or a backend tag like `mqtt`/`llm`, else `log`. */
  source: string;
  message: string;
};

type RecordableLog = {
  level: DevLogLevel;
  source: string;
  /** A thunk defers formatting until flush, so a message that the ring buffer
   *  is about to drop is never built at all. See {@link useDevLogStore.record}. */
  message: string | (() => string);
};

/** Newest-first, bounded so the panel never grows without limit. */
const MAX_ENTRIES = 1000;

type DevLogState = {
  entries: DevLogEntry[];
  paused: boolean;
  record: (entry: RecordableLog) => void;
  clear: () => void;
  setPaused: (paused: boolean) => void;
};

// Monotonic suffix so two entries in the same millisecond still get unique ids.
let counter = 0;

/**
 * Records buffered since the last flush, oldest-first. Every flow event lands
 * here; only a flush touches React.
 */
let pending: (RecordableLog & { timestamp: number; id: string })[] = [];
let flushHandle: ReturnType<typeof setTimeout> | number | null = null;

const scheduleFlush = (flush: () => void): void => {
  if (flushHandle !== null) return;
  flushHandle =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => {
          flushHandle = null;
          flush();
        })
      : setTimeout(() => {
          flushHandle = null;
          flush();
        }, 16);
};

export const useDevLogStore = create<DevLogState>((set, get) => ({
  entries: [],
  paused: false,
  /**
   * Buffer one record; the store's `entries` are republished at most once per
   * frame.
   *
   * A running flow emits component events far faster than a human reads them —
   * a streaming sensor alone is hundreds a second — and each one used to
   * rebuild the whole (up to 1000-entry) array and wake every subscriber. Now a
   * record is an array push, and one frame's worth of events costs one array
   * rebuild and one re-render no matter how many arrived.
   *
   * `message` may be a thunk: it is only called for records that survive the
   * `MAX_ENTRIES` cap, so a burst that overflows the buffer never pays to
   * format the entries it is about to discard.
   */
  record: (entry) => {
    if (get().paused) return;
    counter += 1;
    pending.push({ ...entry, timestamp: Date.now(), id: `${Date.now()}-${counter}` });
    scheduleFlush(() => {
      const batch = pending;
      pending = [];
      if (batch.length === 0) return;
      set((state) => {
        const entries: DevLogEntry[] = [];
        // Newest-first: walk the batch backwards, then take from the previous
        // entries only what still fits under the cap.
        for (let i = batch.length - 1; i >= 0 && entries.length < MAX_ENTRIES; i -= 1) {
          const item = batch[i];
          entries.push({
            id: item.id,
            timestamp: item.timestamp,
            level: item.level,
            source: item.source,
            message: typeof item.message === "function" ? item.message() : item.message,
          });
        }
        for (let i = 0; i < state.entries.length && entries.length < MAX_ENTRIES; i += 1) {
          entries.push(state.entries[i]);
        }
        return { entries };
      });
    });
  },
  clear: () => {
    pending = [];
    set({ entries: [] });
  },
  setPaused: (paused) => {
    if (paused) pending = [];
    set({ paused });
  },
}));
