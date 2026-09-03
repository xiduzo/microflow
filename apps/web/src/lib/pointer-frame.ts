// Pointer events arrive far faster than frames. Every canvas surface that
// reacts to the pointer — the cursor broadcast, handle proximity, placing a new
// node — wants the same thing from that stream: the *latest* position, once per
// animation frame, and nothing left running after teardown.
//
// That rule was written three times, and the three disagreed on the last part.
// It lives here once.

export type XY = { x: number; y: number };

/** The animation-frame clock. Injectable so the coalescing is testable without
 *  a browser, and without the hand-rolled `requestAnimationFrame` polyfill the
 *  DOM-less test runner would otherwise need. */
export interface FrameClock {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
}

const browserClock: FrameClock = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => {
    cancelAnimationFrame(handle);
  },
};

export interface PointerFrame {
  /** Record the latest pointer position and ensure a frame is scheduled. */
  track: (point: XY) => void;
  /** Drop any pending frame. Safe to call repeatedly, and after `cancel`. */
  cancel: () => void;
}

/**
 * Coalesce a pointer stream to one `onFrame` call per animation frame, with the
 * most recent position.
 *
 * Latest-wins: positions arriving between frames are discarded, because a
 * pointer position is a sample of something continuous — the newest one is the
 * only one still true. `cancel` is the half the three hand-rolled copies got
 * inconsistently right, and it is what stops a frame firing into a torn-down
 * subscriber.
 *
 * Attaching to a source is deliberately not this module's job: one caller
 * listens on `document`, one on `window`, and one is a React `onMouseMove`
 * prop. They differ; the coalescing does not.
 */
export function createPointerFrame(
  onFrame: (point: XY) => void,
  clock: FrameClock = browserClock,
): PointerFrame {
  let pending: number | null = null;
  let latest: XY | null = null;

  const flush = () => {
    pending = null;
    if (latest) onFrame(latest);
  };

  return {
    track(point) {
      latest = point;
      if (pending === null) pending = clock.request(flush);
    },
    cancel() {
      if (pending === null) return;
      clock.cancel(pending);
      pending = null;
    },
  };
}
