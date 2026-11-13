import * as Y from "yjs";
import type { RoomStore } from "./room-store";

/**
 * When a room writes its document to the `RoomStore`.
 *
 * - `debounceMs` — quiet period after the last change.
 * - `maxWaitMs` — ceiling on how long a change may stay unsaved. The debounce
 *   re-arms on every edit, so without a ceiling a room where somebody is
 *   always typing is never written.
 * - `retryBaseMs` / `retryMaxMs` — backoff after a failed save: the first
 *   retry waits `retryBaseMs`, each further failure doubles it, capped at
 *   `retryMaxMs`. Retries never give up while the room is in memory.
 */
export type PersistPolicy = {
  debounceMs: number;
  maxWaitMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** Where time comes from. Defaults to `systemClock`; tests pass a manual one. */
  clock?: PersistClock;
};

/**
 * The time seam `RoomPersistence` schedules through. Every debounce, ceiling
 * and backoff decision reads `now()` and arms `setTimeout` here, so a test can
 * drive the whole policy step by step and assert exact delays instead of
 * racing the wall clock.
 */
export type PersistClock = {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** The production clock: `Date.now` and the global timers. */
export const systemClock: PersistClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Keeps one room's document durable: every change the doc accepts reaches the
 * store, however it arrived.
 *
 * The module owns the whole policy — dirty tracking, debounce with a ceiling,
 * retry with backoff — behind three members: `isSettled`, `flush()` and
 * `stop()`. `YjsServer` composes one per room and never reasons about timers
 * or failed writes itself.
 *
 * **Dirty tracking comes from the doc, not the wire.** It listens to the doc's
 * `update` event, which Yjs emits only when a transaction changed the
 * document. The sync message type is not a reliable proxy: a reconnecting
 * client delivers its offline edits as sync step 2, not as an update frame,
 * and inspecting the type lost exactly those edits.
 *
 * Create it *after* the stored state has been applied to the doc, so loading
 * is not mistaken for an edit, and before any migration that should be
 * written back.
 */
export class RoomPersistence {
  private dirty = false;
  /** When the oldest unsaved change happened, or `null` when clean. */
  private firstDirtyAt: number | null = null;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  /** Consecutive failed saves; non-zero means a backoff retry is pending. */
  private failures = 0;
  private stopped = false;
  private readonly clock: PersistClock;

  constructor(
    private readonly flowId: string,
    private readonly doc: Y.Doc,
    private readonly store: RoomStore,
    private readonly policy: PersistPolicy,
    /** Called after every successful save with its timestamp. */
    private readonly onPersisted: (at: number) => void,
    /** Called after every failed save (a backoff retry is already scheduled). */
    private readonly onFailed: (error: unknown) => void = () => {},
  ) {
    this.clock = policy.clock ?? systemClock;
    doc.on("update", this.onUpdate);
  }

  /**
   * True when every change the doc has accepted is in the store: nothing
   * dirty and no save in flight. A room may only be destroyed when settled.
   */
  get isSettled(): boolean {
    return !this.dirty && this.inFlight === null;
  }

  /**
   * Save now rather than at the end of the debounce. Resolves once settled;
   * rejects if a save fails (the backoff retry stays scheduled regardless).
   */
  async flush(): Promise<void> {
    while (!this.stopped) {
      if (this.inFlight) {
        await this.inFlight;
        continue;
      }
      if (!this.dirty) return;
      await this.save();
    }
  }

  /**
   * Stop listening and cancel pending work. Whatever is unsaved stays unsaved
   * — callers stop a room only once it is settled, or when its flow is gone.
   */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.doc.off("update", this.onUpdate);
  }

  private readonly onUpdate = (): void => {
    if (this.stopped) return;
    this.dirty = true;
    this.firstDirtyAt ??= this.clock.now();
    // A backoff retry is already pending and will carry this change; re-arming
    // the debounce would retry a failing store at edit rate.
    if (this.failures > 0) return;
    this.schedule();
  };

  /**
   * Arm the debounce, bounded by what is left of the ceiling. Bounding the
   * timer (rather than checking on the next edit) means the ceiling holds even
   * if the room goes quiet right after it is crossed.
   */
  private schedule(): void {
    this.clearTimer();
    const waited = this.clock.now() - (this.firstDirtyAt ?? this.clock.now());
    const delay = Math.max(0, Math.min(this.policy.debounceMs, this.policy.maxWaitMs - waited));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      // A save in flight reschedules on completion if the room is still dirty.
      if (this.inFlight) return;
      this.save().catch(() => {
        // Logged and retried by `save`; nobody awaits a timer-driven save.
      });
    }, delay);
  }

  private save(): Promise<void> {
    this.clearTimer();
    const firstDirtyAt = this.firstDirtyAt;
    // Clear before the await: a change landing while the write is in flight
    // must leave the room dirty so it is written again.
    this.dirty = false;
    this.firstDirtyAt = null;
    const state = Y.encodeStateAsUpdate(this.doc);

    const attempt = this.store.save(this.flowId, state).then(
      () => {
        this.inFlight = null;
        this.failures = 0;
        if (this.stopped) return;
        if (this.dirty) this.schedule();
        this.onPersisted(this.clock.now());
      },
      (error: unknown) => {
        this.inFlight = null;
        this.dirty = true;
        const now = this.clock.now();
        this.firstDirtyAt = Math.min(firstDirtyAt ?? now, this.firstDirtyAt ?? now);
        this.failures++;
        if (!this.stopped) {
          this.scheduleRetry(error);
          this.onFailed(error);
        }
        throw error;
      },
    );
    this.inFlight = attempt;
    return attempt;
  }

  private scheduleRetry(error: unknown): void {
    const delay = Math.min(
      this.policy.retryMaxMs,
      this.policy.retryBaseMs * 2 ** (this.failures - 1),
    );
    const unsavedForMs = this.clock.now() - (this.firstDirtyAt ?? this.clock.now());
    console.error(
      `[YJS] Room ${this.flowId}: persist failed (attempt ${this.failures}, ` +
        `unsaved for ${unsavedForMs}ms); keeping the document in memory and retrying in ${delay}ms`,
      error,
    );
    this.clearTimer();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.inFlight) return;
      this.save().catch(() => {});
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
