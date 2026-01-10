import { create } from "zustand";
// import { Board, MODES } from '../../common/types';
import { useShallow } from "zustand/shallow";

type BoardState = {
  board: Board;
  setBoard: (board: Board) => void;
};

export const useBoardStore = create<BoardState>((set, get) => {
  return {
    board: { type: "close" },
    setBoard: (board: Board) => {
      set({ board: board });
    },
  };
});

export const usePins = (
  shouldHaveMode?: MODES[],
  shouldNotHaveMode?: MODES[]
) =>
  useBoardStore(
    useShallow((state: BoardState) => {
      if (!state.board.pins) return [];
      if (!shouldHaveMode?.length) return state.board.pins;
      const pins = state.board.pins.filter((pin) =>
        shouldHaveMode.every((mode) => pin.supportedModes.includes(mode))
      );

      if (!shouldNotHaveMode?.length) return pins;

      return pins.filter(
        (pin) =>
          !shouldNotHaveMode.some((mode) => pin.supportedModes.includes(mode))
      );
    })
  );

export const useBoardPort = () =>
  useBoardStore(useShallow(({ board }) => board.port));

export const useBoardCheckResult = () =>
  useBoardStore(useShallow(({ board }) => board.type));

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

export type Board = {
  type:
    | "info"
    | "ready"
    | "fail"
    | "warn"
    | "exit"
    | "close"
    | "error"
    | "connect";
  message?: string;
  port?: string;
  pins?: Pin[];
};

// export type FlowState = {
// 	nodes: Node[];
// 	edges: Edge[];
// };

// export type UploadedCodeMessage = Message;

// export type IpcResponse<T> = { success: true; data: T } | { success: false; error: string };
