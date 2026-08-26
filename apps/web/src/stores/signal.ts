import { useCallback, useSyncExternalStore } from "react";

export type Signal = {
  id: string;
  edgeId: string;
  startTime: number;
};

export const SIGNAL_DURATION = 150;

/** What one edge draws: its live signals and the clock time they were sampled at. */
export type SignalFrame = {
  signals: readonly Signal[];
  now: number;
};

const EMPTY_FRAME: SignalFrame = { signals: [], now: 0 };

// Only edges with at least one live signal have an entry, and only their own
// listeners are woken — an idle edge is never re-rendered by a neighbour's
// traffic.
const frames = new Map<string, SignalFrame>();
const listeners = new Map<string, Set<() => void>>();

// Non-null exactly while a frame is scheduled, which is exactly while at least
// one signal is alive.
let scheduled: ReturnType<typeof setTimeout> | number | null = null;

let counter = 0;

/** `requestAnimationFrame` where it exists (browser); a timer under test/SSR.
 *  Resolved per call, so a test that installs a deterministic frame queue is
 *  honoured no matter when this module was imported. */
const schedule = (tick: () => void) =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(tick) : setTimeout(tick, 16);

function notify(edgeId: string) {
  const subscribers = listeners.get(edgeId);
  if (!subscribers) return;
  for (const listener of subscribers) listener();
}

function subscribe(edgeId: string, listener: () => void): () => void {
  let subscribers = listeners.get(edgeId);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(edgeId, subscribers);
  }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(edgeId);
  };
}

/** Advance every live edge one frame, dropping signals that have run their course. */
function tick() {
  scheduled = null;
  const now = Date.now();

  for (const [edgeId, frame] of frames) {
    const alive = frame.signals.filter((signal) => now - signal.startTime < SIGNAL_DURATION);
    if (alive.length === 0) frames.delete(edgeId);
    else frames.set(edgeId, { signals: alive, now });
    notify(edgeId);
  }

  // Stops itself once the last signal expired.
  if (frames.size > 0) scheduled = schedule(tick);
}

export const signalStore = {
  /** The frame one edge is currently drawing. Idle edges all share
   *  {@link EMPTY_FRAME}, so an idle edge's snapshot never changes identity. */
  get(edgeId: string): SignalFrame {
    return frames.get(edgeId) ?? EMPTY_FRAME;
  },
  /** The edges carrying at least one live signal. */
  edgeIds(): string[] {
    return [...frames.keys()];
  },
  addSignal(edgeId: string) {
    const now = Date.now();
    counter += 1;
    const signal: Signal = { id: `${edgeId}-${now}-${counter}`, edgeId, startTime: now };

    const frame = frames.get(edgeId);
    frames.set(edgeId, { signals: frame ? [...frame.signals, signal] : [signal], now });

    // Deliberately *not* notified here. A flow turn can fire dozens of signals
    // down one edge, each in its own task, and waking the edge per signal would
    // cost one render each. The clock below publishes them together on the next
    // frame — which is the soonest the animation could show them anyway.
    if (scheduled === null) scheduled = schedule(tick);
  },

  clearSignals() {
    const edgeIds = [...frames.keys()];
    frames.clear();
    // Stop the clock as well as emptying the store — a live handle would keep
    // `addSignal` from re-arming it, leaving the next signal undrawn.
    if (scheduled !== null) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(scheduled as number);
      else clearTimeout(scheduled as ReturnType<typeof setTimeout>);
      scheduled = null;
    }
    for (const edgeId of edgeIds) notify(edgeId);
  },
};

export function useEdgeSignals(edgeId: string): SignalFrame {
  return useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(edgeId, listener), [edgeId]),
    () => frames.get(edgeId) ?? EMPTY_FRAME,
    () => EMPTY_FRAME,
  );
}
