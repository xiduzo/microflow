// Virtual time for tests of whatever waits on `Timers`: nothing fires until a
// test advances it.

import type { Timers } from "./timers";

export class FakeTimers implements Timers {
  private now = 0;
  private nextHandle = 1;
  private readonly armed = new Map<number, { at: number; callback: () => void }>();

  set(callback: () => void, ms: number): unknown {
    const handle = this.nextHandle++;
    this.armed.set(handle, { at: this.now + ms, callback });
    return handle;
  }

  clear(handle: unknown): void {
    this.armed.delete(handle as number);
  }

  /** Let `ms` pass, firing what comes due in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.armed].filter(([, timer]) => timer.at <= end);
      if (due.length === 0) break;
      const [handle, timer] = due.reduce((first, next) => (next[1].at < first[1].at ? next : first));
      this.armed.delete(handle);
      this.now = timer.at;
      timer.callback();
    }
    this.now = end;
  }

  /** How many waits are running. */
  get waiting(): number {
    return this.armed.size;
  }
}
