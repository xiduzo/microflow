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
  setBoard: (board: Board) => void;
};

export const useBoardStore = create<BoardStoreState>((set) => {
  return {
    board: { state: "disconnected" },
    setBoard: (board: Board) => {
      set({ board: board });
    },
  };
});

export function useBoardEvents() {
  const setBoard = useBoardStore((state) => state.setBoard);

  useListen<Board>({
    type: "board-state",
    handler: ({ payload }) => {
      console.log(payload);
      setBoard(payload);
    },
  });
}

export const usePins = (shouldHaveMode?: MODES[], shouldNotHaveMode?: MODES[]) => {
  const boardPins = useBoardStore(
    useShallow((state) => (state.board.state === "connected" ? state.board.pins : ([] as Pin[]))),
  );

  const filteredPins = useMemo(() => {
    if (!shouldHaveMode?.length) return boardPins;
    const pins = boardPins.filter((pin) =>
      shouldHaveMode.every((mode) => pin.supportedModes.includes(mode)),
    );

    if (!shouldNotHaveMode?.length) return pins;
    return pins.filter(
      (pin) => !shouldNotHaveMode.some((mode) => pin.supportedModes.includes(mode)),
    );
  }, [boardPins, shouldHaveMode, shouldNotHaveMode]);

  return filteredPins;
};

export const useBoardPort = () =>
  useBoardStore(useShallow(({ board }) => (board.state === "connected" ? board.port : undefined)));

export const useBoardState = () => useBoardStore(useShallow(({ board }) => board.state));

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
