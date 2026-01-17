import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import { useMemo } from "react";
import { useListen } from "@/utils/ipc";

type BoardState = {
  board: Board;
  setBoard: (board: Board) => void;
};

export const useBoardStore = create<BoardState>((set, get) => {
  return {
    board: { state: "disconnected", pins: [] },
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
    useShallow((state) => (state.board.state === "connected" ? state.board.pins : [])),
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

export type Pin = {
  supportedModes: MODES[];
  analogChannel: number;
  mode?: unknown;
  pin: number;
};

type BoardReady = {
  state: "connected";
  port: string;
  firmwareName: string;
  firmwareVersion: string;
  pins: Array<{
    pin: number;
    supportedModes: MODES[];
    analogChannel: number;
  }>;
};

type BoardError = {
  state: "error";
  error?: string;
};

type BoardDisconnected = {
  state: "disconnected";
};

type BoardConnecting = {
  state: "connecting";
};

type BoardFlashing = {
  state: "flashing";
  port: string;
  board: string;
};

export type Board = BoardReady | BoardError | BoardDisconnected | BoardConnecting | BoardFlashing;
