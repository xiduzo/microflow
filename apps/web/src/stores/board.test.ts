import { describe, expect, it, beforeEach } from "bun:test";
import { MODES, useBoardStore, type Board, type Pin } from "./board";

const pin = (n: number, modes: MODES[]): Pin => ({
  pin: n,
  analogChannel: 127,
  supportedModes: [...modes],
});

// Each `board-state` event is freshly deserialized, so every payload holds
// structurally-equal-but-distinct pin objects. `connected` mimics that.
const connected = (pins: Pin[]): Board => ({
  state: "connected",
  port: "/dev/tty.usb",
  pins: pins.map((p) => ({ ...p, supportedModes: [...p.supportedModes] })),
});

/** Counts what a `useBoardStore((s) => s.pins)` subscriber would re-render on. */
function countPinNotifications() {
  let count = 0;
  const unsubscribe = useBoardStore.subscribe((state, previous) => {
    if (!Object.is(state.pins, previous.pins)) count += 1;
  });
  return { count: () => count, unsubscribe };
}

describe("board store pin identity", () => {
  beforeEach(() => {
    useBoardStore.setState({ board: { state: "disconnected" }, pins: [], pinsIdentity: "" });
  });

  it("does not notify pin subscribers when a board event carries unchanged pins", () => {
    const pins = [pin(3, [MODES.OUTPUT, MODES.PWM]), pin(4, [MODES.INPUT])];
    const { count, unsubscribe } = countPinNotifications();

    useBoardStore.getState().setBoard(connected(pins));
    expect(count()).toBe(1);

    useBoardStore.getState().setBoard(connected(pins));
    useBoardStore.getState().setBoard(connected(pins));
    expect(count()).toBe(1);

    unsubscribe();
  });

  it("keeps the pins array reference stable across identical board events", () => {
    const pins = [pin(3, [MODES.OUTPUT, MODES.PWM])];

    useBoardStore.getState().setBoard(connected(pins));
    const first = useBoardStore.getState().pins;

    useBoardStore.getState().setBoard(connected(pins));
    expect(useBoardStore.getState().pins).toBe(first);
    // `board.pins` is canonicalised too, so `useBoard()` stays shallow-stable.
    const board = useBoardStore.getState().board;
    expect(board.state === "connected" && board.pins).toBe(first);
  });

  it("notifies when a pin's supported modes change", () => {
    const { count, unsubscribe } = countPinNotifications();

    useBoardStore.getState().setBoard(connected([pin(3, [MODES.OUTPUT])]));
    useBoardStore.getState().setBoard(connected([pin(3, [MODES.OUTPUT, MODES.PWM])]));
    expect(count()).toBe(2);

    unsubscribe();
  });

  it("notifies when the board disconnects", () => {
    useBoardStore.getState().setBoard(connected([pin(3, [MODES.OUTPUT])]));
    const { count, unsubscribe } = countPinNotifications();

    useBoardStore.getState().setBoard({ state: "disconnected" });
    expect(count()).toBe(1);
    expect(useBoardStore.getState().pins).toEqual([]);

    unsubscribe();
  });
});
