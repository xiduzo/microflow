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
  message: string;
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

export const useDevLogStore = create<DevLogState>((set, get) => ({
  entries: [],
  paused: false,
  record: (entry) => {
    if (get().paused) return;
    counter += 1;
    const next: DevLogEntry = {
      id: `${Date.now()}-${counter}`,
      timestamp: Date.now(),
      level: entry.level,
      source: entry.source,
      message: entry.message,
    };
    set((state) => {
      const entries = [next, ...state.entries];
      if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
      return { entries };
    });
  },
  clear: () => set({ entries: [] }),
  setPaused: (paused) => set({ paused }),
}));
