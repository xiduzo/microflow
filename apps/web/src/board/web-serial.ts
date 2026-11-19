// Web Serial transport for the browser Firmata client.
//
// WASM can't block on the Web Serial Promises, so the async transport lives in
// JS. The port lifecycle — open → handshake → ready/attached → lost → closed —
// is `board-link.ts`; this module binds it to the real browser
// (`navigator.serial`, the wasm detection codec, the wall clock) and keeps the
// flashing driver, which owns the port outright for its duration. The
// handshake mirrors the desktop `hardware::firmata` detection — same reset,
// same patience for the board to boot, same queries — because both sides drive
// the identical protocol codec.
//
// Web Serial is Chromium-only (Chrome/Edge/Opera) and never auto-lists ports:
// a port is only obtained after a user gesture calls `requestPort()`, which
// shows the browser's port picker.

import type { BoardState } from "@/lib/bindings/BoardState";
import {
  createFlashSession,
  createSession,
  detectBoardFromUsb,
  flashAdvance,
  flashBaud,
  flashStart,
  guessBoardFromUsb,
  parseHex,
  sessionPins,
  standardFirmataHex,
  type FirmataSession,
  type FlashSession,
} from "./wasm";
import { realClock, type Clock } from "./clock";
import {
  browserSerial,
  watchConnectivity,
  type ConnectivityHandlers,
  type WebSerial,
  type WebSerialPort,
  type WebSerialPortInfo,
} from "./serial-port";
import { probeBoard, type BoardConnection, type ProbeEnv, type ProbeHooks } from "./board-link";

// The board link's interface, re-exported so other verticals keep importing it
// from this module (the board vertical's public surface).
export type { BoardConnection, LinkLoss, ProbeHooks } from "./board-link";
export { pumpReader } from "./board-link";
export type { WebSerialPort } from "./serial-port";

// --- Connection -------------------------------------------------------------

const browserProbeEnv: ProbeEnv = {
  clock: realClock,
  createSession,
  listGrantedPorts: () => listGrantedPorts(),
};

/** True only in browsers that implement the Web Serial API (Chromium-based). */
export function isWebSerialSupported(): boolean {
  return browserSerial() !== undefined;
}

/** Obtain a port via the browser picker. Must run inside a user gesture. */
export async function requestBoardPort(): Promise<WebSerialPort> {
  const serial = browserSerial();
  if (!serial) throw new Error("Web Serial is not supported in this browser");
  // Throws if the user dismisses the picker — let it propagate.
  return serial.requestPort();
}

/** Ports the origin was already granted — no picker, no gesture. */
export async function listGrantedPorts(): Promise<WebSerialPort[]> {
  const serial = browserSerial();
  if (!serial) return [];
  return serial.getPorts();
}

/** The Firmata probe on `port` (see `probeBoard`): a `ready` link, or null with
 *  the port closed again. */
export function probeFirmata(port: WebSerialPort, hooks: ProbeHooks): Promise<BoardConnection | null> {
  return probeBoard(browserProbeEnv, port, hooks, { afterFlash: false });
}

/** Post-flash probe (`probe { afterFlash: true }`): wait for the reboot, then
 *  probe, tolerating USB re-enumeration (see `probeBoard`). */
export function probeAfterFlash(
  port: WebSerialPort,
  hooks: ProbeHooks,
): Promise<BoardConnection | null> {
  return probeBoard(browserProbeEnv, port, hooks, { afterFlash: true });
}

/**
 * Subscribe to Web Serial connect/disconnect for already-granted devices — the
 * browser fires these when such a device is plugged/unplugged, the closest
 * equivalent to the desktop port poll. Returns an unsubscribe; no-op outside
 * Chromium.
 */
export function onSerialConnectivity(handlers: ConnectivityHandlers): () => void {
  return watchConnectivity(browserSerial(), handlers);
}

/** Build the `connected` BoardState from the session + the port's USB ids. */
export function connectedState(port: WebSerialPort, session: FirmataSession): BoardState {
  const pins = sessionPins(session);
  return {
    state: "connected",
    port: portLabel(port.getInfo()),
    firmwareName: session.firmwareName(),
    firmwareVersion: session.firmwareVersion(),
    pins,
  };
}

/** A human-ish label for the port (Web Serial exposes no device path). */
export function portLabel(info: WebSerialPortInfo): string {
  if (info.usbVendorId !== undefined && info.usbProductId !== undefined) {
    const vid = info.usbVendorId.toString(16).padStart(4, "0");
    const pid = info.usbProductId.toString(16).padStart(4, "0");
    return `USB ${vid}:${pid}`;
  }
  return "Serial port";
}

/**
 * The board id the port's USB vendor/product id positively identifies (an
 * official Arduino VID) — the only board that may be flashed without asking.
 */
export async function detectBoard(port: WebSerialPort): Promise<string | undefined> {
  const info = port.getInfo();
  if (info.usbVendorId === undefined || info.usbProductId === undefined) {
    return undefined;
  }
  return detectBoardFromUsb(info.usbVendorId, info.usbProductId);
}

/**
 * The board id the port's USB id names or suggests, including a generic
 * USB-serial chip's guess (CH340 → "nano"). Enough to probe or to offer a flash.
 */
export async function guessBoard(port: WebSerialPort): Promise<string | undefined> {
  const info = port.getInfo();
  if (info.usbVendorId === undefined || info.usbProductId === undefined) {
    return undefined;
  }
  return guessBoardFromUsb(info.usbVendorId, info.usbProductId);
}

// --- Flashing ---------------------------------------------------------------

export type FlashProgress = (done: number, total: number) => void;

/** Concatenate two byte arrays. */
function concat(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Flash StandardFirmata onto an already-granted port (no picker). Flashes
 * `opts.board` — the board the bring-up machine decided on (positively
 * identified, or confirmed by the user) — or else the board the USB id
 * positively identifies; picks the embedded firmware + bootloader protocol, and
 * runs the shared sans-IO driver. Resolves with the flashed board id.
 */
export async function flashPort(
  port: WebSerialPort,
  opts: { board?: string; onProgress?: FlashProgress } = {},
): Promise<string> {
  const serial = browserSerial();
  if (!serial) {
    throw new Error("Web Serial is not supported in this browser");
  }
  const board = opts.board ?? (await detectBoard(port));
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
  await runFlash({ serial, clock: realClock }, port, baud, session, opts.onProgress);
  return board;
}

/** What a flash needs of the browser besides its port: where a bootloader that
 *  re-enumerated is found again, and the time its waits run on. */
export interface FlashEnv {
  serial: Pick<WebSerial, "getPorts" | "requestPort">;
  clock: Clock;
}

/**
 * The browser's executor of the core flash drivers: carry out a `FlashSession`'s
 * steps on a Web Serial port, opened at `baud`, and feed back what the board
 * answered (the contract is in `microflow_core::flasher::driver`). Rejects with
 * the driver's error; the port is closed either way.
 */
export async function runFlash(
  env: FlashEnv,
  initialPort: WebSerialPort,
  baud: number,
  session: FlashSession,
  onProgress?: FlashProgress,
): Promise<void> {
  const { serial, clock } = env;
  const sleep = (ms: number) => clock.sleep(ms);
  let port = initialPort;
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let readerDone: Promise<void> = Promise.resolve();
  // Diagnostics: total bytes the board sends across the whole attempt. 0 ⇒ the
  // board stayed silent (reset likely never entered the bootloader); a large
  // count of Firmata-looking bytes ⇒ the board is still running the old sketch.
  let totalRx = 0;

  const startIo = async () => {
    reader = port.readable!.getReader();
    writer = port.writable!.getWriter();
    readerDone = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader!.read();
          if (done) break;
          if (value && value.length > 0) {
            totalRx += value.length;
            buffer = concat(buffer, value);
          }
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

  // A transact's read: `n` bytes or whatever is in when `timeoutMs` has
  // passed. One deadline for the step, which bytes coming in do not extend:
  // the drivers' bounds on how long a flash takes rest on it.
  const readExact = async (n: number, timeoutMs: number): Promise<Uint8Array> => {
    if (n === 0) return new Uint8Array(0);
    const deadline = clock.now() + timeoutMs;
    while (buffer.length < n && clock.now() < deadline) {
      await sleep(10);
    }
    const take = Math.min(n, buffer.length);
    const out = buffer.slice(0, take);
    buffer = buffer.slice(take);
    return out;
  };

  await port.open({ baudRate: baud, bufferSize: 1024 });
  await startIo();
  console.debug(`[flash] opened @ ${baud} baud — driving bootloader`);
  try {
    let step = flashStart(session);
    let guard = 0;
    for (;;) {
      if (++guard > 1_000_000) throw new Error("Flash driver did not terminate");
      if (step.kind === "done") break;
      if (step.kind === "error") {
        console.warn(`[flash] aborting: ${step.message} — board sent ${totalRx} bytes total`);
        throw new Error(step.message);
      }

      let input: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      switch (step.kind) {
        case "setBaud":
          console.debug(`[flash] switch baud → ${step.baud}`);
          await reopen(step.baud);
          break;
        case "reset":
          console.debug(`[flash] reset dtr=${step.dtr} rts=${step.rts} (+${step.delayMs}ms)`);
          try {
            await port.setSignals({ dataTerminalReady: step.dtr, requestToSend: step.rts });
          } catch (error) {
            // If the adapter can't toggle DTR/RTS the board never enters the
            // bootloader — make that visible rather than silently failing sync.
            console.warn("[flash] setSignals threw (no DTR reset):", error);
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
        case "transact": {
          // Bootloaders are strict request→response: discard any stale input
          // (reset noise, a still-running sketch's output) before a command,
          // mirroring the desktop flasher's `clear(ClearBuffer::Input)`. Without
          // this the first `readExact` returns boot garbage and sync never aligns.
          // A step that says `keepInput` reads on in the buffer as it is: an
          // answer that came in late is in it, and the driver knows what to
          // make of it.
          if (!step.keepInput) buffer = new Uint8Array(0);
          if (step.write.length > 0) await writer!.write(Uint8Array.from(step.write));
          input = await readExact(step.readLen, step.timeoutMs);
          // Log the protocol commands (not the bulk page writes) so a failing
          // sync shows exactly what the board replied with.
          if (step.write.length < 32) {
            const hex = (a: ArrayLike<number>) =>
              Array.from(a, (b) => b.toString(16).padStart(2, "0")).join(" ");
            console.debug(
              `[flash] cmd 0x${(step.write[0] ?? 0).toString(16)} → ${input.length}/${step.readLen} [${hex(input)}]`,
            );
          }
          break;
        }
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
      step = flashAdvance(session, input);
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
async function reacquirePort(serial: FlashEnv["serial"]): Promise<WebSerialPort> {
  const ports = await serial.getPorts();
  if (ports.length > 0) {
    return ports[ports.length - 1];
  }
  return serial.requestPort();
}
