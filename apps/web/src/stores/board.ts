import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import { useMemo } from "react";
import { useListen, type BoardState, type PinInfo } from "@/lib/ipc";

// `Board` is the legacy alias the rest of the app uses for the generated
// tagged-union payload of the `board-state` Tauri event.
export type Board = BoardState;
export type Pin = PinInfo;

type BoardStoreState = {
  board: Board;
  /** Reference-stable while pin *identity* is unchanged — see `pinsIdentity`. */
  pins: Pin[];
  pinsIdentity: string;
  setBoard: (board: Board) => void;
};

const NO_PINS: Pin[] = [];

/**
 * Value identity of a pin list. Every `board-state` event carries a freshly
 * deserialized `Pin[]`, so reference equality is always false; this string is
 * what decides whether pin subscribers are notified.
 */
export function pinsIdentity(pins: Pin[]): string {
  return pins.map((p) => `${p.pin}:${p.analogChannel}:${p.supportedModes.join(".")}`).join("|");
}

const boardPins = (board: Board): Pin[] => (board.state === "connected" ? board.pins : NO_PINS);

export const useBoardStore = create<BoardStoreState>((set, get) => {
  return {
    board: { state: "disconnected" },
    pins: NO_PINS,
    pinsIdentity: "",
    setBoard: (board: Board) => {
      const pins = boardPins(board);
      const identity = pinsIdentity(pins);
      // Keep the previous `pins` reference when nothing about the pins changed,
      // so an unrelated board event does not wake every pin subscriber.
      if (identity === get().pinsIdentity) {
        const previous = get().pins;
        set({ board: board.state === "connected" ? { ...board, pins: previous } : board });
        return;
      }
      set({ board, pins, pinsIdentity: identity });
    },
  };
});

export function useBoardEvents() {
  const setBoard = useBoardStore((state) => state.setBoard);

  useListen<Board>({
    type: "board-state",
    handler: ({ payload }) => {
      setBoard(payload);
    },
  });
}

/**
 * Subscribe to the board pins, optionally filtered by mode.
 *
 * Callers may pass inline array literals: the memo is keyed on the *contents*
 * of the mode arrays, not their identity, so a fresh literal per render does
 * not re-run the filter.
 */
export const usePins = (shouldHaveMode?: MODES[], shouldNotHaveMode?: MODES[]) => {
  const pins = useBoardStore((state) => state.pins);
  const requiredKey = shouldHaveMode?.join(",") ?? "";
  const forbiddenKey = shouldNotHaveMode?.join(",") ?? "";

  return useMemo(() => {
    // Derived from the keys rather than the array props so the memo can never
    // close over a stale filter.
    const required = requiredKey ? requiredKey.split(",").map(Number) : [];
    if (!required.length) return pins;

    const filtered = pins.filter((pin) =>
      required.every((mode) => pin.supportedModes.includes(mode)),
    );

    const forbidden = forbiddenKey ? forbiddenKey.split(",").map(Number) : [];
    if (!forbidden.length) return filtered;
    return filtered.filter((pin) => !forbidden.some((mode) => pin.supportedModes.includes(mode)));
  }, [pins, requiredKey, forbiddenKey]);
};

export const useBoardPort = () =>
  useBoardStore(useShallow(({ board }) => (board.state === "connected" ? board.port : undefined)));

export const useBoardState = () => useBoardStore(useShallow(({ board }) => board.state));

export const useBoardError = () =>
  useBoardStore(useShallow(({ board }) => (board.state === "error" ? board.error : null)));

export const useBoard = () => useBoardStore(useShallow(({ board }) => board));

export enum MODES {
  INPUT = 0,
  OUTPUT = 1,
  ANALOG = 2,
  PWM = 3,
  SERVO = 4,
  SHIFT = 5,
  I2C = 6,
  ONEWIRE = 7,
  STEPPER = 8,
  ENCODER = 9,
  SERIAL = 10,
  PULLUP = 11,
  SPI = 12,
  SONAR = 13,
  TONE = 14,
  DHT = 15,
  IGNORE = 127,
  PING_READ = 117,
  UNKOWN = 16,
}

export const PIN_MODES = new Map<MODES, string>([
  [MODES.INPUT, "input"],
  [MODES.OUTPUT, "output"],
  [MODES.ANALOG, "analog"],
  [MODES.PWM, "pwm"],
  [MODES.SERVO, "servo"],
  [MODES.SHIFT, "shift"],
  [MODES.I2C, "i2c"],
  [MODES.ONEWIRE, "onewire"],
  [MODES.STEPPER, "stepper"],
  [MODES.SERIAL, "serial"],
  [MODES.PULLUP, "pullup"],
  [MODES.SPI, "spi"],
  [MODES.SONAR, "sonar"],
  [MODES.TONE, "tone"],
  [MODES.DHT, "dht"],
  [MODES.IGNORE, "ignore"],
  [MODES.PING_READ, "ping_read"],
  [MODES.UNKOWN, "unkown"],
]);

// `Board` and `Pin` are re-exported above as aliases for the generated
// `BoardState` / `PinInfo` types — the legacy hand-typed unions are gone so
// drift between Rust and TS is structurally impossible.
