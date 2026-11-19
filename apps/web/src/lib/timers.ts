// The one-shot timers the cloud modules and the LLM provider settings wait on,
// behind a seam with two adapters: `setTimeout` in the app, virtual time
// (`fake-timers.ts`) in tests.

/** One-shot timers, as `setTimeout` gives them. A test passes virtual time. */
export type Timers = {
  set(callback: () => void, ms: number): unknown;
  /** `handle` is what `set` returned. */
  clear(handle: unknown): void;
};

export const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
