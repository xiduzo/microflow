// Time as a seam. The board link waits a lot — the DTR reset pulse, the
// handshake's requery cadence, the post-flash reboot, the reconnect backoff —
// and every one of those waits is policy a test needs to drive without a real
// clock. The production adapter is `realClock`; tests bind a fake that advances
// virtual time on demand.

/** An opaque timer handle, only ever handed back to the clock that made it. */
export type TimerHandle = unknown;

export interface Clock {
  /** Monotonic milliseconds; only differences are meaningful. */
  now(): number;
  /** Resolve after `ms`. */
  sleep(ms: number): Promise<void>;
  /** Run `fn` once after `ms`; cancel with {@link Clock.clearTimer}. */
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

export const realClock: Clock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
