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
  /**
   * A thunk instead of a string keeps the message unformatted until the panel
   * reads the row — the flow ingest records thousands of rows nobody looks at.
   */
  message: string | (() => string);
};

/** Newest-first, bounded so the panel never grows without limit. */
const MAX_ENTRIES = 1000;

/** Records land here first and reach React in batches, not one commit each. */
const FLUSH_INTERVAL_MS = 100;

type DevLogState = {
  entries: DevLogEntry[];
  paused: boolean;
  record: (entry: RecordableLog) => void;
  clear: () => void;
  setPaused: (paused: boolean) => void;
};

// Monotonic suffix so two entries in the same millisecond still get unique ids.
let counter = 0;

// Oldest-first; drained into `entries` (newest-first) by `flush`.
let pending: DevLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function entryOf(entry: RecordableLog): DevLogEntry {
  counter += 1;
  const timestamp = Date.now();
  const base = {
    id: `${timestamp}-${counter}`,
    timestamp,
    level: entry.level,
    source: entry.source,
  };

  if (typeof entry.message === "string") return { ...base, message: entry.message };

  const format = entry.message;
  let formatted: string | undefined;
  return Object.defineProperty(base, "message", {
    enumerable: true,
    get: () => (formatted ??= format()),
  }) as DevLogEntry;
}

function flush() {
  flushTimer = null;
  if (pending.length === 0) return;

  const batch = pending.reverse();
  pending = [];
  useDevLogStore.setState((state) => {
    const entries = batch.concat(state.entries);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    return { entries };
  });
}

export const useDevLogStore = create<DevLogState>((set, get) => ({
  entries: [],
  paused: false,
  /**
   * Buffer one record; the store's `entries` are republished at most once per
   * {@link FLUSH_INTERVAL_MS}.
   *
   * A running flow emits component events far faster than a human reads them —
   * a streaming sensor alone is hundreds a second — and each one used to
   * rebuild the whole (up to 1000-entry) array and wake every subscriber. Now a
   * record is an array push, and one flush interval's worth of events costs one
   * array rebuild and one re-render no matter how many arrived.
   *
   * `message` may be a thunk, and stays one: the row formats itself the first
   * time something reads it, so records that overflow the buffer or are never
   * scrolled into view never pay to be formatted at all.
   */
  record: (entry) => {
    if (get().paused) return;
    pending.push(entryOf(entry));
    if (pending.length > MAX_ENTRIES) pending.splice(0, pending.length - MAX_ENTRIES);
    if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  },
  clear: () => {
    pending = [];
    // Disarm too, so a record made right after a clear waits its own full
    // interval rather than riding the previous batch's deadline.
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    set({ entries: [] });
  },
  setPaused: (paused) => set({ paused }),
}));
