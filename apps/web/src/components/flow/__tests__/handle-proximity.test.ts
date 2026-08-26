import { describe, expect, test } from "bun:test";
import {
  HANDLE_SPACING,
  PROXIMITY_MIN_ZOOM,
  PROXIMITY_RADIUS,
  handleAnchor,
  isHandleNearPointer,
} from "../handle-proximity";

const NODE = { x: 100, y: 100, width: 200, height: 160 };

describe("handleAnchor", () => {
  test("left and right anchors sit on opposite edges at the same height", () => {
    const left = handleAnchor(NODE, "left");
    const right = handleAnchor(NODE, "right");

    expect(left.y).toBe(right.y);
    expect(left.x).toBeLessThan(right.x);
    expect(right.x).toBeLessThan(NODE.x + NODE.width);
    expect(left.x).toBeGreaterThan(NODE.x);
  });

  test("offset walks side handles down by one spacing step", () => {
    const first = handleAnchor(NODE, "left", 0);
    const second = handleAnchor(NODE, "left", 1);

    expect(second.y - first.y).toBeCloseTo(HANDLE_SPACING);
    expect(second.x).toBe(first.x);
  });

  test("offset walks bottom handles sideways, not down", () => {
    const first = handleAnchor(NODE, "bottom", 0);
    const second = handleAnchor(NODE, "bottom", 1);

    expect(second.x - first.x).toBeCloseTo(HANDLE_SPACING * 2);
    expect(second.y).toBe(first.y);
  });
});

describe("isHandleNearPointer", () => {
  const near = (pointer: { x: number; y: number }, zoom = 1) =>
    isHandleNearPointer({ node: NODE, position: "left", pointer, zoom });

  test("pointer on the handle is near", () => {
    expect(near(handleAnchor(NODE, "left"))).toBe(true);
  });

  test("pointer just inside the radius is near", () => {
    const anchor = handleAnchor(NODE, "left");
    expect(near({ x: anchor.x + PROXIMITY_RADIUS - 1, y: anchor.y })).toBe(true);
  });

  test("pointer well outside the radius is not near", () => {
    const anchor = handleAnchor(NODE, "left");
    expect(near({ x: anchor.x + PROXIMITY_RADIUS * 2, y: anchor.y })).toBe(false);
  });

  test("radius is in flow units, so zoom does not change the answer", () => {
    const anchor = handleAnchor(NODE, "left");
    const pointer = { x: anchor.x + PROXIMITY_RADIUS - 1, y: anchor.y };

    expect(near(pointer, 1)).toBe(true);
    expect(near(pointer, 4)).toBe(true);
  });

  test("affordance is off below the minimum zoom, even on the handle", () => {
    expect(near(handleAnchor(NODE, "left"), PROXIMITY_MIN_ZOOM - 0.01)).toBe(false);
    expect(near(handleAnchor(NODE, "left"), PROXIMITY_MIN_ZOOM)).toBe(true);
  });

  test("handles on the same node are distinguished by offset", () => {
    const far = { x: NODE.x, y: NODE.y + NODE.height / 2 + HANDLE_SPACING * 40 };

    expect(
      isHandleNearPointer({ node: NODE, position: "left", offset: 40, pointer: far, zoom: 1 }),
    ).toBe(true);
    expect(
      isHandleNearPointer({ node: NODE, position: "left", offset: 0, pointer: far, zoom: 1 }),
    ).toBe(false);
  });
});
