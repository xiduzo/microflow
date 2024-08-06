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
  SERIAL = 10,
  PULLUP = 11,
  IGNORE = 127,
  PING_READ = 117,
  UNKOWN = 16
}

export type Pin = {
  supportedModes: MODES[],
  analogChannel: number,
  mode?: unknown,
  pin: number
}

export type BoardCheckResult = {
  type: "info" | "ready" | "fail" | "warn" | "exit" | "close" | "error",
  port?: string,
  pins?: Pin[],
  message?: string,
  class?: "Available" | "Connected" | "Board"
}

export type BoardFlashResult = {
  type: "done" | "error" | "flashing"
  message?: string
}

export type UploadCodeResult = {
  type: "info" | "ready" | "fail" | "warn" | "exit" | "close" | "error",
  message?: string,
  pins?: Pin[]
}

export type UploadedCodeMessage = {
  nodeId: string,
  action: string,
  value?: unknown,
}
