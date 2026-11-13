import type { PersistClock } from "./room-persistence";

/**
 * Test adapter for the `PersistClock` seam: time only moves when the test
 * says so, and every delay `RoomPersistence` arms is recorded. Persistence
 * tests assert exact debounce, ceiling and backoff delays with it instead of
 * sleeping and hoping the machine kept up.
 */
export class ManualClock implements PersistClock {
  private time = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; run: () => void }>();
  /** Every delay armed through `setTimeout`, in order. */
  readonly armed: number[] = [];

  now = (): number => this.time;

  setTimeout = (run: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.pending.set(id, { at: this.time + ms, run });
    this.armed.push(ms);
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  /** Timers armed and not yet fired or cleared. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Move time forward by `ms`, firing every timer that falls due on the way,
   * in order, and letting the async work each one starts (a store save and
   * its completion handlers) settle before the next fires.
   */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    // Work already started (a save the test triggered directly) may still be
    // about to arm a timer; let it, so that timer counts in this advance.
    await settle();
    for (let next = this.due(target); next; next = this.due(target)) {
      this.pending.delete(next.id);
      this.time = next.at;
      next.run();
      await settle();
    }
    this.time = target;
    await settle();
  }

  /** Jump straight to the next timer and fire it. Returns the time waited, or `null`. */
  async runNext(): Promise<number | null> {
    await settle();
    const next = this.due(Number.POSITIVE_INFINITY);
    if (!next) return null;
    const waited = next.at - this.time;
    await this.advance(waited);
    return waited;
  }

  private due(limit: number): { id: number; at: number; run: () => void } | null {
    let earliest: { id: number; at: number; run: () => void } | null = null;
    for (const [id, timer] of this.pending) {
      if (timer.at > limit) continue;
      if (!earliest || timer.at < earliest.at) earliest = { id, ...timer };
    }
    return earliest;
  }
}

/** Drain the microtask queue: a macrotask runs only once it is empty. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
