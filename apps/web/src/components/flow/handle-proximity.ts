/**
 * Pointer-proximity source for handle affordances.
 *
 * One `mousemove` listener for the whole canvas, coalesced to one animation
 * frame, feeding a pure geometric rule. Proximity is computed from geometry
 * ReactFlow already holds — node position + size, both in flow coordinates —
 * so no handle ever measures the DOM.
 */

/** Rendered size of a handle, in flow units (CSS px at zoom 1). */
export const HANDLE_SIZE = 18;
export const HANDLE_TRANSLATE_OFFSET = HANDLE_SIZE * 0.9;
export const HANDLE_SPACING_OFFSET = 14;
export const HANDLE_SPACING = HANDLE_SIZE * 1.5;

/**
 * Radius of the affordance, in flow units. Screen distance scales with zoom
 * and so does the radius, so the two cancel and the flow-space radius is a
 * constant.
 */
export const PROXIMITY_RADIUS = 200;

/** Below this zoom the labels are unreadable, so the affordance stays off. */
export const PROXIMITY_MIN_ZOOM = 0.75;

export type HandlePosition = "left" | "right" | "bottom";

export type XY = { x: number; y: number };

/** A node's box in flow coordinates. */
export type NodeBox = XY & { width: number; height: number };

/**
 * Where a handle sits in flow coordinates — the same offsets the handle is
 * rendered with, expressed as geometry instead of CSS.
 */
export function handleAnchor(node: NodeBox, position: HandlePosition, offset = 0): XY {
  switch (position) {
    case "left":
      return {
        x: node.x + HANDLE_TRANSLATE_OFFSET,
        y: node.y + node.height / 2 + HANDLE_SPACING * offset + HANDLE_SPACING_OFFSET,
      };
    case "right":
      return {
        x: node.x + node.width - HANDLE_TRANSLATE_OFFSET,
        y: node.y + node.height / 2 + HANDLE_SPACING * offset + HANDLE_SPACING_OFFSET,
      };
    case "bottom":
      return {
        x: node.x + node.width / 2 + HANDLE_SPACING * 2 * offset,
        y: node.y + node.height - HANDLE_TRANSLATE_OFFSET,
      };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * The proximity rule. Pure: all inputs are numbers in flow space, so it is
 * testable without a DOM and cheap enough to run per handle per frame.
 */
export function isHandleNearPointer(args: {
  node: NodeBox;
  position: HandlePosition;
  offset?: number;
  /** Pointer in flow coordinates. */
  pointer: XY;
  zoom: number;
}): boolean {
  if (args.zoom < PROXIMITY_MIN_ZOOM) return false;

  const anchor = handleAnchor(args.node, args.position, args.offset);
  const half = HANDLE_SIZE / 2;
  const closestX = clamp(args.pointer.x, anchor.x - half, anchor.x + half);
  const closestY = clamp(args.pointer.y, anchor.y - half, anchor.y + half);

  return Math.hypot(args.pointer.x - closestX, args.pointer.y - closestY) <= PROXIMITY_RADIUS;
}

// ---------------------------------------------------------------------------
// Shared pointer source
// ---------------------------------------------------------------------------

export type ProximitySubscriber = {
  /** Screen → flow conversion for the canvas this handle belongs to. */
  toFlow: (screen: XY) => XY;
  getZoom: () => number;
  /** The rule, already bound to this handle's geometry. */
  near: (pointerFlow: XY, zoom: number) => boolean;
  /** Called only when the boolean flips. */
  onChange: (near: boolean) => void;
};

type Entry = ProximitySubscriber & { last: boolean };

const subscribers = new Set<Entry>();
let pointer: XY | null = null;
let frame: number | null = null;

function handlePointerMove(event: MouseEvent): void {
  pointer = { x: event.clientX, y: event.clientY };
  if (frame === null) frame = requestAnimationFrame(flushProximity);
}

function flushProximity(): void {
  frame = null;
  if (!pointer) return;

  // ponytail: one canvas is mounted per document (ADR-0004), so any
  // subscriber's viewport converter is *the* viewport — converting once per
  // frame keeps `screenToFlowPosition`'s container measurement off the
  // per-handle path. Group entries per canvas if a second one is ever mounted.
  const first = subscribers.values().next().value;
  if (!first) return;

  const pointerFlow = first.toFlow(pointer);
  const zoom = first.getZoom();

  for (const entry of subscribers) {
    const near = entry.near(pointerFlow, zoom);
    if (near === entry.last) continue;
    entry.last = near;
    entry.onChange(near);
  }
}

/** Register a handle. Returns the unsubscribe. */
export function subscribeToPointerProximity(subscriber: ProximitySubscriber): () => void {
  const entry: Entry = { ...subscriber, last: false };
  subscribers.add(entry);
  if (subscribers.size === 1) {
    window.addEventListener("mousemove", handlePointerMove);
  }

  return () => {
    subscribers.delete(entry);
    if (subscribers.size > 0) return;
    window.removeEventListener("mousemove", handlePointerMove);
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  };
}
