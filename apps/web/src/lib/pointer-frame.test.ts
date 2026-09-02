import { describe, expect, test } from "bun:test";
import { createPointerFrame, type FrameClock, type XY } from "./pointer-frame";

/** A hand-driven frame clock: nothing fires until `runFrame` is called. */
function testClock() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const clock: FrameClock = {
    request(callback) {
      const handle = next++;
      pending.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      pending.delete(handle);
    },
  };
  return {
    clock,
    get scheduled() {
      return pending.size;
    },
    runFrame() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, callback] of entries) callback();
    },
  };
}

describe("createPointerFrame", () => {
  test("coalesces a burst into one call with the latest position", () => {
    const seen: XY[] = [];
    const t = testClock();
    const frame = createPointerFrame((p) => seen.push(p), t.clock);

    frame.track({ x: 1, y: 1 });
    frame.track({ x: 2, y: 2 });
    frame.track({ x: 3, y: 3 });
    expect(seen).toEqual([]);
    expect(t.scheduled).toBe(1);

    t.runFrame();
    expect(seen).toEqual([{ x: 3, y: 3 }]);
  });

  test("schedules again after a frame has run", () => {
    const seen: XY[] = [];
    const t = testClock();
    const frame = createPointerFrame((p) => seen.push(p), t.clock);

    frame.track({ x: 1, y: 1 });
    t.runFrame();
    frame.track({ x: 9, y: 9 });
    t.runFrame();

    expect(seen).toEqual([
      { x: 1, y: 1 },
      { x: 9, y: 9 },
    ]);
  });

  test("cancel stops a pending frame from firing", () => {
    // The half the three hand-rolled copies disagreed on: a frame that fires
    // into a torn-down subscriber.
    const seen: XY[] = [];
    const t = testClock();
    const frame = createPointerFrame((p) => seen.push(p), t.clock);

    frame.track({ x: 1, y: 1 });
    frame.cancel();
    t.runFrame();

    expect(seen).toEqual([]);
    expect(t.scheduled).toBe(0);
  });

  test("cancel is idempotent and does not block later tracking", () => {
    const seen: XY[] = [];
    const t = testClock();
    const frame = createPointerFrame((p) => seen.push(p), t.clock);

    frame.cancel();
    frame.cancel();
    frame.track({ x: 4, y: 4 });
    t.runFrame();

    expect(seen).toEqual([{ x: 4, y: 4 }]);
  });

  test("a frame with nothing tracked calls nothing", () => {
    const seen: XY[] = [];
    const t = testClock();
    createPointerFrame((p) => seen.push(p), t.clock);
    t.runFrame();
    expect(seen).toEqual([]);
  });
});
