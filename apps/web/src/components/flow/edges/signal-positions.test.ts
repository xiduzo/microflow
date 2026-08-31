import { describe, expect, test } from "bun:test";

import { parseBezierPath, signalPositions } from "./animated-edge";
import { SIGNAL_DURATION, type Signal } from "@/stores/signal";

const linear = parseBezierPath("not-a-bezier", 0, 0, 100, 200);
const curve = parseBezierPath("M 0,0 C 50,0 50,100 100,100", 0, 0, 100, 100);

function signal(id: string, startTime: number): Signal {
  return { id, edgeId: "e1", startTime };
}

describe("signalPositions", () => {
  test("walks a signal from the source to the target over its lifetime", () => {
    const start = 1_000;

    expect(signalPositions([signal("s", start)], start, linear)).toEqual([{ id: "s", x: 0, y: 0 }]);
    expect(signalPositions([signal("s", start)], start + SIGNAL_DURATION / 2, linear)).toEqual([
      { id: "s", x: 50, y: 100 },
    ]);
    expect(signalPositions([signal("s", start)], start + SIGNAL_DURATION, linear)).toEqual([
      { id: "s", x: 100, y: 200 },
    ]);
  });

  test("clamps a signal that is not born yet or has overrun", () => {
    expect(signalPositions([signal("s", 1_000)], 900, linear)).toEqual([{ id: "s", x: 0, y: 0 }]);
    expect(signalPositions([signal("s", 1_000)], 9_000, linear)).toEqual([
      { id: "s", x: 100, y: 200 },
    ]);
  });

  test("follows the bezier control points, not the straight line", () => {
    const [position] = signalPositions([signal("s", 0)], SIGNAL_DURATION / 2, curve);

    expect(position.x).toBeCloseTo(50, 6);
    expect(position.y).toBeCloseTo(50, 6);
    // Halfway along this curve is not halfway along the chord's tangent.
    expect(curve.isLinear).toBe(false);
  });

  test("maps every signal on the edge, keyed by signal id", () => {
    const positions = signalPositions([signal("a", 0), signal("b", 75)], 150, linear);

    expect(positions.map((position) => position.id)).toEqual(["a", "b"]);
    expect(positions[0]).toEqual({ id: "a", x: 100, y: 200 });
    expect(positions[1]).toEqual({ id: "b", x: 50, y: 100 });
  });

  test("no signals means nothing to draw", () => {
    expect(signalPositions([], Date.now(), linear)).toEqual([]);
  });
});
