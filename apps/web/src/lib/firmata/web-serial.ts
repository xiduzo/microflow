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
export interface WebSerialPort {
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
/** Wait for the board to reboot into a freshly-flashed sketch before reconnect. */
const POST_FLASH_RESET_MS = 2500;

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
  /** The granted port backing this connection (identity-compared on unplug). */
  port: WebSerialPort;
};

type ConnectOptions = {
  /** Called whenever the board's connection state changes. */
  onState: (state: BoardState) => void;
  /** Called for each pin value change the board reports. */
  onPinChange?: PinChangeHandler;
  /** Flash progress (done..total) while auto-flashing during bring-up. */
  onProgress?: FlashProgress;
  /** The board's read loop ended unexpectedly (reset / unplug mid-session). */
  onClosed?: () => void;
};

/**
 * Prompt for a serial port and bring the board fully online. Must be called from
 * a user gesture (the browser shows its port picker). Auto-flashes StandardFirmata
 * if the board has none, mirroring the desktop orchestrator.
 */
export async function connectBoard(options: ConnectOptions): Promise<BoardConnection> {
  const port = await requestBoardPort();
  return bringUpBoard(port, options, { autoFlash: true, onProgress: options.onProgress });
}

/** Obtain a port via the browser picker. Must run inside a user gesture. */
export async function requestBoardPort(): Promise<WebSerialPort> {
  const serial = getSerial();
  if (!serial) throw new Error("Web Serial is not supported in this browser");
  // Throws if the user dismisses the picker — let it propagate.
  return serial.requestPort();
}

/** Ports the origin was already granted — no picker, no gesture. */
export async function listGrantedPorts(): Promise<WebSerialPort[]> {
  const serial = getSerial();
  if (!serial) return [];
  return serial.getPorts();
}

/** Run the firmware/capability handshake at each supported baud (fresh session). */
async function tryHandshake(
  port: WebSerialPort,
  options: ConnectOptions,
): Promise<BoardConnection | null> {
  const session = await createSession();
  for (const baud of BAUD_RATES) {
    const connection = await tryConnectAtBaud(port, baud, session, options);
    if (connection) return connection;
  }
  return null;
}

/**
 * Bring a board online on an already-obtained port, mirroring the desktop
 * orchestrator (`hardware::process_usb_port`): probe Firmata; if absent and the
 * board is recognised, flash StandardFirmata on the same port and reconnect.
 *
 * `autoFlash` gates the flashing branch — background paths pass `false` so a
 * transient probe miss never reflashes; the explicit user connect passes `true`.
 */
export async function bringUpBoard(
  port: WebSerialPort,
  options: ConnectOptions,
  opts: { autoFlash?: boolean; onProgress?: FlashProgress } = {},
): Promise<BoardConnection> {
  // 1. Steady state: the board already speaks Firmata — just connect.
  const existing = await tryHandshake(port, options);
  if (existing) return existing;

  // 2. No Firmata. Identify the board; only recognised boards can be flashed.
  const board = await detectBoard(port);
  if (!board) {
    throw new Error("No Firmata firmware responded and the board could not be identified.");
  }
  if (!opts.autoFlash) {
    throw new Error(`No Firmata on ${board}.`);
  }

  // 3. Flash StandardFirmata on the same granted port (no second picker).
  options.onState({ state: "flashing", port: portLabel(port.getInfo()), board });
  await flashPort(port, { onProgress: opts.onProgress ?? options.onProgress });

  // 4. The board reboots into the freshly-flashed sketch. Give it a moment, then
  //    handshake again — the original handle returns in application mode; if it
  //    re-enumerated (AVR109), fall back to the newest granted port.
  await sleep(POST_FLASH_RESET_MS);
  const direct = await tryHandshake(port, options).catch(() => null);
  const reconnected = direct ?? (await reconnectAfterFlash(options));
  if (reconnected) return reconnected;
  throw new Error(`Flashed ${board}, but it did not come back up with Firmata.`);
}

/** After a flash that re-enumerated the device, find it among granted ports. */
async function reconnectAfterFlash(options: ConnectOptions): Promise<BoardConnection | null> {
  const ports = await listGrantedPorts();
  for (const port of ports.slice().reverse()) {
    const connection = await tryHandshake(port, options).catch(() => null);
    if (connection) return connection;
  }
  return null;
}

/**
 * Subscribe to Web Serial connect/disconnect for already-granted devices — the
 * browser fires these when such a device is plugged/unplugged, the closest
 * equivalent to the desktop port poll. Returns an unsubscribe; no-op outside
 * Chromium.
 */
export function onSerialConnectivity(handlers: {
  onConnect?: (port: WebSerialPort) => void;
  onDisconnect?: (port: WebSerialPort) => void;
}): () => void {
  const serial = getSerial();
  if (!serial) return () => {};
  const target = serial as unknown as EventTarget;
  const portOf = (event: Event): WebSerialPort =>
    (event.target as unknown as WebSerialPort) ??
    (event as unknown as { port: WebSerialPort }).port;
  const onConnect = (event: Event) => handlers.onConnect?.(portOf(event));
  const onDisconnect = (event: Event) => handlers.onDisconnect?.(portOf(event));
  target.addEventListener("connect", onConnect);
  target.addEventListener("disconnect", onDisconnect);
  return () => {
    target.removeEventListener("connect", onConnect);
    target.removeEventListener("disconnect", onDisconnect);
  };
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
  // Distinguishes a deliberate teardown from the board dropping mid-session.
  let tornDown = false;

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
    // Board reset or was unplugged while connected — let the caller recover.
    if (!tornDown) options.onClosed?.();
  })();

  const teardown = async () => {
    tornDown = true;
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

  return { write, session, disconnect: teardown, port };
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
  const port = await requestBoardPort();
  return flashPort(port, opts);
}

/**
 * Flash StandardFirmata onto an already-granted port (no picker). Identifies the
 * board from its USB id, picks the embedded firmware + bootloader protocol, and
 * runs the shared sans-IO driver. Resolves with the flashed board id.
 */
export async function flashPort(
  port: WebSerialPort,
  opts: { onProgress?: FlashProgress } = {},
): Promise<string> {
  const serial = getSerial();
  if (!serial) {
    throw new Error("Web Serial is not supported in this browser");
  }
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
  console.debug(`[flash] opened @ ${baud} baud — driving bootloader`);
  try {
    let step = JSON.parse(session.start()) as FlashStep;
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
          // (reset noise, a still-running sketch's output) before each command,
          // mirroring the desktop flasher's `clear(ClearBuffer::Input)`. Without
          // this the first `readExact` returns boot garbage and sync never aligns.
          buffer = new Uint8Array(0);
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
