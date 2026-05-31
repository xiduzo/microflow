// Web Serial transport for the browser Firmata client.
//
// WASM can't block on the Web Serial Promises, so the async transport lives
// here in JS: we open the port, run a persistent read loop that feeds incoming
// bytes to the wasm `FirmataSession` (the codec), and write the session's
// encoder output back. The handshake (firmware + capability + analog-mapping
// queries) mirrors the desktop `hardware::firmata` detection exactly — same
// reset, same patience for the board to boot, same queries — because both sides
// drive the identical protocol codec.
//
// Web Serial is Chromium-only (Chrome/Edge/Opera) and never auto-lists ports:
// a port is only obtained after a user gesture calls `requestPort()`, which
// shows the browser's port picker.

import type { BoardState } from "@/lib/bindings/BoardState";
import type { PinInfo } from "@/lib/bindings/PinInfo";
import {
  createFlashSession,
  createSession,
  detectBoardFromUsb,
  flashBaud,
  parseHex,
  standardFirmataHex,
  type FeedResult,
  type FirmataSession,
  type FlashSession,
  type FlashStep,
} from "./wasm";

// --- Minimal Web Serial typings (the TS DOM lib does not ship them) ---------

interface WebSerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}
interface WebSerialOptions {
  baudRate: number;
  bufferSize?: number;
}
interface WebSerialSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
}
interface WebSerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: WebSerialOptions): Promise<void>;
  close(): Promise<void>;
  getInfo(): WebSerialPortInfo;
  setSignals(signals: WebSerialSignals): Promise<void>;
}
interface WebSerial {
  requestPort(): Promise<WebSerialPort>;
  getPorts(): Promise<WebSerialPort[]>;
}

/** The Web Serial entry point, or undefined outside Chromium browsers. */
function getSerial(): WebSerial | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as unknown as { serial?: WebSerial }).serial;
}

// --- Connection -------------------------------------------------------------

/** Baud rates to try, matching desktop detection (`find_firmata_baud`). */
const BAUD_RATES = [57600, 115200];
/** Wait up to this long for the board to boot and answer the firmware query. */
const FIRMWARE_TIMEOUT_MS = 6000;
/** Re-send the firmware query about once a second across that window. */
const FIRMWARE_REQUERY_MS = 1000;
/** Capability + analog-mapping responses arrive quickly once firmware is up. */
const CAPABILITY_TIMEOUT_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True only in browsers that implement the Web Serial API (Chromium-based). */
export function isWebSerialSupported(): boolean {
  return getSerial() !== undefined;
}

export type PinChangeHandler = (pin: number, value: number, isAnalog: boolean) => void;

export type BoardConnection = {
  /** Write raw Firmata bytes to the board (from a session encoder). */
  write: (bytes: Uint8Array) => Promise<void>;
  /** The protocol session — use its `encode*` methods to build command bytes. */
  session: FirmataSession;
  /** Tear down the read loop and close the port. */
  disconnect: () => Promise<void>;
};

type ConnectOptions = {
  /** Called whenever the board's connection state changes. */
  onState: (state: BoardState) => void;
  /** Called for each pin value change the board reports. */
  onPinChange?: PinChangeHandler;
};

/**
 * Prompt for a serial port and connect to a Firmata board. Must be called from
 * a user gesture (the browser shows its port picker). Resolves once the board
 * has answered the firmware/capability handshake, or rejects if no Firmata
 * board responds on any supported baud rate.
 */
export async function connectBoard(options: ConnectOptions): Promise<BoardConnection> {
  const serial = getSerial();
  if (!serial) {
    throw new Error("Web Serial is not supported in this browser");
  }
  // Throws if the user dismisses the picker — let it propagate.
  const port = await serial.requestPort();
  const session = await createSession();

  for (const baud of BAUD_RATES) {
    const connection = await tryConnectAtBaud(port, baud, session, options);
    if (connection) {
      return connection;
    }
  }

  throw new Error("No Firmata board responded on the selected port");
}

/** Attempt the full open → reset → handshake at one baud rate. */
async function tryConnectAtBaud(
  port: WebSerialPort,
  baud: number,
  session: FirmataSession,
  options: ConnectOptions,
): Promise<BoardConnection | null> {
  await port.open({ baudRate: baud, bufferSize: 1024 });

  // Reset the board (DTR/RTS toggle), mirroring desktop `reset_board`. Not all
  // platforms honour signals; ignore failures.
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(250);
    await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    await sleep(1500);
  } catch {
    // Signals unsupported — the board may already be in a good state.
  }

  const reader = port.readable!.getReader();
  const writer = port.writable!.getWriter();
  const write = (bytes: Uint8Array) => writer.write(bytes);

  // Persistent read loop: feed every incoming chunk to the codec and surface
  // pin changes. Ends when the reader is cancelled (on disconnect / teardown).
  const readLoop = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          const result = JSON.parse(session.feed(value)) as FeedResult;
          for (const change of result.pinChanges) {
            options.onPinChange?.(change.pin, change.value, change.isAnalog);
          }
        }
      }
    } catch {
      // Port closed / disconnected mid-read — fall through to teardown.
    }
  })();

  const teardown = async () => {
    try {
      await reader.cancel();
    } catch {
      /* already cancelled */
    }
    await readLoop;
    try {
      reader.releaseLock();
    } catch {
      /* not locked */
    }
    try {
      await writer.close();
    } catch {
      /* already closed */
    }
    try {
      await port.close();
    } catch {
      /* already closed */
    }
  };

  // Handshake: query firmware, re-sending periodically while the board boots.
  await write(session.encodeQueryFirmware());
  const firmwareDeadline = Date.now() + FIRMWARE_TIMEOUT_MS;
  let lastQuery = Date.now();
  while (session.firmwareName() === "" && Date.now() < firmwareDeadline) {
    await sleep(100);
    if (Date.now() - lastQuery >= FIRMWARE_REQUERY_MS) {
      await write(session.encodeQueryFirmware());
      lastQuery = Date.now();
    }
  }

  if (session.firmwareName() === "") {
    // No Firmata at this baud — tear down and let the caller try the next one.
    await teardown();
    return null;
  }

  // Firmware found: gather capabilities + analog mapping (sizes the pin table).
  await write(session.encodeQueryCapabilities());
  await write(session.encodeQueryAnalogMapping());
  const capDeadline = Date.now() + CAPABILITY_TIMEOUT_MS;
  while (pinCount(session) === 0 && Date.now() < capDeadline) {
    await sleep(100);
  }

  options.onState(connectedState(port, session));

  return { write, session, disconnect: teardown };
}

/** Number of pins the session currently knows about. */
function pinCount(session: FirmataSession): number {
  return (JSON.parse(session.pinsJson()) as PinInfo[]).length;
}

/** Build the `connected` BoardState from the session + the port's USB ids. */
function connectedState(port: WebSerialPort, session: FirmataSession): BoardState {
  const pins = JSON.parse(session.pinsJson()) as PinInfo[];
  return {
    state: "connected",
    port: portLabel(port.getInfo()),
    firmwareName: session.firmwareName(),
    firmwareVersion: session.firmwareVersion(),
    pins,
  };
}

/** A human-ish label for the port (Web Serial exposes no device path). */
function portLabel(info: WebSerialPortInfo): string {
  if (info.usbVendorId !== undefined && info.usbProductId !== undefined) {
    const vid = info.usbVendorId.toString(16).padStart(4, "0");
    const pid = info.usbProductId.toString(16).padStart(4, "0");
    return `USB ${vid}:${pid}`;
  }
  return "Serial port";
}

/** Best-effort board id from the port's USB vendor/product id (for flashing). */
export async function detectBoard(port: WebSerialPort): Promise<string | undefined> {
  const info = port.getInfo();
  if (info.usbVendorId === undefined || info.usbProductId === undefined) {
    return undefined;
  }
  return detectBoardFromUsb(info.usbVendorId, info.usbProductId);
}

// --- Flashing ---------------------------------------------------------------

export type FlashProgress = (done: number, total: number) => void;

/** Concatenate two byte arrays. */
function concat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Flash StandardFirmata onto a board over Web Serial. Prompts for a port,
 * identifies the board from its USB id, picks the embedded firmware + bootloader
 * protocol, and runs the shared sans-IO driver. Resolves with the flashed board
 * id, or rejects with a readable error. Must be called from a user gesture.
 */
export async function flashStandardFirmata(opts: {
  onProgress?: FlashProgress;
}): Promise<string> {
  const serial = getSerial();
  if (!serial) {
    throw new Error("Web Serial is not supported in this browser");
  }
  const port = await serial.requestPort();
  const board = await detectBoard(port);
  if (!board) {
    throw new Error(
      "Couldn't identify the board from its USB id — browser flashing needs a recognised Arduino (Uno, Nano, Mega, Leonardo, or Micro).",
    );
  }
  const hex = await standardFirmataHex(board);
  if (!hex) {
    throw new Error(`No StandardFirmata image is bundled for '${board}'.`);
  }
  const flash = await parseHex(hex);
  const session = await createFlashSession(board, flash);
  const baud = (await flashBaud(board)) ?? 57600;
  await runFlash(serial, port, baud, session, opts.onProgress);
  return board;
}

/** Drive a `FlashSession` step machine against the Web Serial port. */
async function runFlash(
  serial: WebSerial,
  initialPort: WebSerialPort,
  baud: number,
  session: FlashSession,
  onProgress?: FlashProgress,
): Promise<void> {
  let port = initialPort;
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let readerDone: Promise<void> = Promise.resolve();

  const startIo = async () => {
    reader = port.readable!.getReader();
    writer = port.writable!.getWriter();
    readerDone = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader!.read();
          if (done) break;
          if (value && value.length > 0) buffer = concat(buffer, value);
        }
      } catch {
        /* port closed */
      }
    })();
  };

  const stopIo = async () => {
    try {
      await reader?.cancel();
    } catch {
      /* already cancelled */
    }
    await readerDone;
    try {
      reader?.releaseLock();
    } catch {
      /* not locked */
    }
    try {
      await writer?.close();
    } catch {
      /* already closed */
    }
    reader = null;
    writer = null;
  };

  const reopen = async (b: number) => {
    await stopIo();
    try {
      await port.close();
    } catch {
      /* already closed */
    }
    await port.open({ baudRate: b, bufferSize: 1024 });
    buffer = new Uint8Array(0);
    await startIo();
  };

  const readExact = async (n: number, timeoutMs: number): Promise<Uint8Array> => {
    if (n === 0) return new Uint8Array(0);
    const deadline = Date.now() + timeoutMs;
    while (buffer.length < n && Date.now() < deadline) {
      await sleep(10);
    }
    const take = Math.min(n, buffer.length);
    const out = buffer.slice(0, take);
    buffer = buffer.slice(take);
    return out;
  };

  await port.open({ baudRate: baud, bufferSize: 1024 });
  await startIo();
  try {
    let step = JSON.parse(session.start()) as FlashStep;
    let guard = 0;
    for (;;) {
      if (++guard > 1_000_000) throw new Error("Flash driver did not terminate");
      if (step.kind === "done") break;
      if (step.kind === "error") throw new Error(step.message);

      let input: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      switch (step.kind) {
        case "setBaud":
          await reopen(step.baud);
          break;
        case "reset":
          try {
            await port.setSignals({ dataTerminalReady: step.dtr, requestToSend: step.rts });
          } catch {
            /* signals unsupported */
          }
          await sleep(step.delayMs);
          break;
        case "flushInput":
          buffer = new Uint8Array(0);
          break;
        case "delay":
          await sleep(step.ms);
          break;
        case "progress":
          onProgress?.(step.done, step.total);
          break;
        case "transact":
          if (step.write.length > 0) await writer!.write(Uint8Array.from(step.write));
          input = await readExact(step.readLen, step.timeoutMs);
          break;
        case "reacquirePort": {
          await stopIo();
          try {
            await port.close();
          } catch {
            /* already closed */
          }
          await sleep(step.waitMs);
          port = await reacquirePort(serial);
          await port.open({ baudRate: step.baud, bufferSize: 1024 });
          buffer = new Uint8Array(0);
          await startIo();
          break;
        }
      }
      step = JSON.parse(session.advance(input)) as FlashStep;
    }
  } finally {
    await stopIo();
    try {
      await port.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Re-acquire the bootloader port after an AVR109 1200-baud touch. The bootloader
 * re-enumerates as a new USB device; prefer an already-granted port, else prompt
 * (which needs a user gesture and may fail mid-flash on some setups).
 */
async function reacquirePort(serial: WebSerial): Promise<WebSerialPort> {
  const ports = await serial.getPorts();
  if (ports.length > 0) {
    return ports[ports.length - 1];
  }
  return serial.requestPort();
}
