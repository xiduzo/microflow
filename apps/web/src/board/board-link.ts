// The board link: one open serial port, from `open` to `close`, as one object.
//
// Before this module the lifecycle of a browser board connection was implicit
// in `tryConnectAtBaud`'s locals — a `tornDown` closure, a reader and a writer
// nobody else could reach, and no cleanup on any path that threw — and the
// question "is the port open?" had no single answer. `SerialBoardLink` owns it:
//
//     probing ──handshake ok──▶ ready ──attachInbound──▶ attached
//        │                        │                         │
//        │                        └──── reader ends / ──────┤
//        │                              write rejects       ▼
//        │                                                 lost
//        └──────────────── disconnect() ──────────────────▶ closed
//
// - `probing`: the handshake owns the port; inbound bytes reach only the
//   detection codec. Any failure here closes the port before `probeBoard`
//   returns — a leaked open port fails every later attempt with "port is
//   already open".
// - `ready`: the handshake answered. The pin seed is snapshotted and, in the
//   same synchronous step, inbound bytes start queueing — so seed + queue is the
//   exact stream the detection codec saw, and nothing that arrives while the
//   flow runtime is still being stood up is dropped (ADR-0018).
// - `attached`: the queue was replayed in order into the sink; bytes now stream.
// - `lost`: the transport failed — the reader ended or a write rejected. The
//   owner hears it once, through `onLost`; a deliberate `disconnect()` is never
//   reported as a loss.
// - `closed`: terminal. `disconnect()` is idempotent and leaves the board in a
//   safe state first when the port still works (outputs low, Firmata reset).
//
// Every import is type-only: the codec comes in as an argument and time
// through the `Clock` seam, so tests drive the whole lifecycle over a fake port
// without wasm.

import type { FirmataSession } from "./wasm";
import type { Clock } from "./clock";
import type { WebSerialPort } from "./serial-port";
import { advance, startHandshake, BAUD_RATES, RESET_PULSE_MS, RESET_SETTLE_MS } from "./probe-handshake";

/** Why a live link stopped working. */
export type LinkLoss = { cause: "readerEnded" } | { cause: "writeFailed"; error: unknown };

export type LinkPhase = "probing" | "ready" | "attached" | "lost" | "closed";

/** One live board connection — the interface the controller and the flow
 *  runtime hold. */
export interface BoardConnection {
  /** The granted port backing this link (identity-compared on unplug). */
  readonly port: WebSerialPort;
  /** The detection codec — answers the handshake and `connectedState`. */
  readonly session: FirmataSession;
  /** The detection codec's pin table at the instant the handshake completed:
   *  the flow runtime's one-shot seed (ADR-0018 D3). Every byte after it is in
   *  the inbound stream `attachInbound` replays. */
  readonly pinSeed: string;
  readonly phase: LinkPhase;
  /** Write raw Firmata bytes. A rejection means the port is broken: the link
   *  turns `lost` and reports it, so the caller need only avoid an unhandled
   *  rejection. */
  write(bytes: Uint8Array): Promise<void>;
  /** Hand inbound bytes to `sink`: first everything queued since the handshake,
   *  in arrival order, then each chunk as it arrives. Once per link. */
  attachInbound(sink: (bytes: Uint8Array) => void): void;
  /** Leave the board safe, end the read loop and close the port. Idempotent:
   *  every call returns the same promise. Never rejects. */
  disconnect(): Promise<void>;
}

export type ProbeHooks = {
  /** A live link lost its transport (board reset, unplug, a rejected write).
   *  Fires at most once per link and never for a deliberate `disconnect()`. */
  onLost?: (link: BoardConnection, loss: LinkLoss) => void;
};

/** What a probe needs from the outside world. */
export interface ProbeEnv {
  clock: Clock;
  /** A fresh detection codec for one probe. */
  createSession(): Promise<FirmataSession>;
  /** Granted ports — the post-flash probe's fallback for re-enumerated boards. */
  listGrantedPorts(): Promise<WebSerialPort[]>;
}

/** Wait for the board to reboot into a freshly-flashed sketch before reconnect. */
export const POST_FLASH_RESET_MS = 2500;
/** Inbound chunks a `ready` link queues before it starts dropping the oldest —
 *  bounds memory when no sink ever attaches (the runtime failed to load). */
export const MAX_QUEUED_CHUNKS = 4096;
/** Patience for each teardown step that waits on the device; a stalled port
 *  must not stall the controller's serialised queue behind it. */
export const TEARDOWN_STEP_MS = 500;

/**
 * Firmata `SYSTEM_RESET` (0xFF), the middle of the safe state the link writes
 * before a healthy close. The bytes come from core's one encoder
 * (`FirmataSession.encodeSafeState`, `microflow_core::firmata::encode_safe_state`),
 * shared with the desktop host.
 */
export const FIRMATA_SYSTEM_RESET = 0xff;

/** Resolve with the promise's outcome, or `"timeout"` after `ms`. Never rejects. */
async function within(clock: Clock, ms: number, promise: Promise<unknown>): Promise<"ok" | "timeout"> {
  let timer: unknown;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = clock.setTimer(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([promise.then(() => "ok" as const, () => "ok" as const), timeout]);
  } finally {
    clock.clearTimer(timer);
  }
}

/** Exported for tests, which drive the probing → ready edge directly; the app
 *  only ever gets links from `probeBoard`. */
export class SerialBoardLink implements BoardConnection {
  phase: LinkPhase = "probing";
  pinSeed = "[]";
  /** Set by the read loop or a rejected write while `probing`: the handshake
   *  stops waiting for a board that can no longer answer. */
  transportFailed = false;
  private queue: Uint8Array[] = [];
  private sink: ((bytes: Uint8Array) => void) | null = null;
  private closing: Promise<void> | null = null;
  private readonly readLoop: Promise<void>;

  constructor(
    readonly port: WebSerialPort,
    readonly session: FirmataSession,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
    private readonly clock: Clock,
    private readonly onLost: ProbeHooks["onLost"],
  ) {
    this.readLoop = pumpReader(reader, session, {
      onBytes: (bytes) => this.inbound(bytes),
      onClosed: () => this.lose({ cause: "readerEnded" }),
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.phase === "lost" || this.phase === "closed") {
      return Promise.reject(new Error(`board link is ${this.phase}`));
    }
    return this.writer.write(bytes).catch((error: unknown) => {
      this.lose({ cause: "writeFailed", error });
      throw error;
    });
  }

  /**
   * The handshake answered: snapshot the seed and start queueing, together.
   * False — and the link stays `probing`, for the caller to close — when the
   * transport already failed: the reader can end in the hop between the
   * handshake's last check and this call, and a `ready` link over a dead reader
   * would never report its loss.
   */
  markReady(): boolean {
    if (this.transportFailed) return false;
    this.pinSeed = this.session.pinsJson();
    this.phase = "ready";
    return true;
  }

  attachInbound(sink: (bytes: Uint8Array) => void): void {
    if (this.phase !== "ready") return;
    const queued = this.queue;
    this.queue = [];
    this.phase = "attached";
    this.sink = sink;
    // Synchronous, so no live chunk can overtake the replay.
    for (const chunk of queued) this.deliver(chunk);
  }

  disconnect(): Promise<void> {
    this.closing ??= this.teardown();
    return this.closing;
  }

  private inbound(bytes: Uint8Array): void {
    switch (this.phase) {
      case "ready":
        if (this.queue.length >= MAX_QUEUED_CHUNKS) this.queue.shift();
        this.queue.push(bytes);
        break;
      case "attached":
        this.deliver(bytes);
        break;
      // `probing`: the detection codec already has it, and no runtime exists
      // to want it. `lost` / `closed`: nobody is listening any more.
    }
  }

  private deliver(bytes: Uint8Array): void {
    try {
      this.sink?.(bytes);
    } catch (error) {
      // Same containment as `pumpReader`: a sink fault is not transport news.
      console.error("[board-link] inbound sink threw:", error);
    }
  }

  private lose(loss: LinkLoss): void {
    if (this.phase === "probing") {
      this.transportFailed = true;
      return;
    }
    if (this.phase !== "ready" && this.phase !== "attached") return;
    this.phase = "lost";
    this.sink = null;
    this.queue = [];
    this.onLost?.(this, loss);
  }

  private async teardown(): Promise<void> {
    // Outputs were only ever driven by a link that got past the handshake, and a
    // lost link cannot carry the reset anyway.
    const healthy = this.phase === "ready" || this.phase === "attached";
    this.phase = "closed";
    this.sink = null;
    this.queue = [];
    if (healthy) {
      try {
        await within(this.clock, TEARDOWN_STEP_MS, this.writer.write(this.session.encodeSafeState()));
      } catch (error) {
        console.warn("[board-link] could not encode the safe state:", error);
      }
    }
    try {
      await this.reader.cancel();
    } catch {
      /* already cancelled */
    }
    await this.readLoop;
    try {
      this.reader.releaseLock();
    } catch {
      /* not locked */
    }
    // `close` waits for queued writes; a device that stopped draining would
    // hold it forever, so give up after a bound and abort instead.
    if ((await within(this.clock, TEARDOWN_STEP_MS, this.writer.close())) === "timeout") {
      await within(this.clock, TEARDOWN_STEP_MS, this.writer.abort());
    }
    try {
      this.writer.releaseLock();
    } catch {
      /* not locked */
    }
    try {
      await this.port.close();
    } catch (error) {
      console.warn("[board-link] port.close failed:", error);
    }
  }
}

/** Number of pins the codec has sized its table to. */
function pinCount(session: Pick<FirmataSession, "pinsJson">): number {
  return (JSON.parse(session.pinsJson()) as unknown[]).length;
}

/** DTR/RTS reset, mirroring desktop `reset_board`. Not every platform honours
 *  signals; a board that ignores them may already be in a good state. */
async function resetBoard(port: WebSerialPort, clock: Clock): Promise<void> {
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await clock.sleep(RESET_PULSE_MS);
    await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    await clock.sleep(RESET_SETTLE_MS);
  } catch {
    // Signals unsupported.
  }
}

/** Run the handshake on a `probing` link. True when Firmata answered. The
 *  policy (requery cadence, deadlines) lives in `probe-handshake.ts`; this loop
 *  only performs its actions. */
async function handshake(link: SerialBoardLink, session: FirmataSession, clock: Clock): Promise<boolean> {
  let state = startHandshake(clock.now());
  for (;;) {
    if (link.transportFailed) return false;
    const step = advance(state, clock.now(), {
      firmwareName: session.firmwareName(),
      pinCount: pinCount(session),
    });
    state = step.state;
    switch (step.action.kind) {
      case "sendFirmwareQuery":
        await link.write(session.encodeQueryFirmware());
        break;
      case "sendCapabilityQueries":
        // Sizes the pin table.
        await link.write(session.encodeQueryCapabilities());
        await link.write(session.encodeQueryAnalogMapping());
        break;
      case "poll":
        await clock.sleep(step.action.delayMs);
        break;
      case "noFirmata":
        return false;
      case "connected":
        return true;
    }
  }
}

/**
 * Open `port` at one baud and run the handshake. Returns a `ready` link, or
 * null with the port closed again — on a miss, and on any throw after `open`
 * (a rejected write, a stream that never appeared). Only `open` itself may
 * reject, and then there is nothing to close.
 */
async function tryConnectAtBaud(
  env: ProbeEnv,
  port: WebSerialPort,
  baud: number,
  session: FirmataSession,
  hooks: ProbeHooks,
): Promise<SerialBoardLink | null> {
  await port.open({ baudRate: baud, bufferSize: 1024 });
  let link: SerialBoardLink | null = null;
  try {
    await resetBoard(port, env.clock);
    const reader = port.readable?.getReader();
    if (!reader) throw new Error("the port opened without a readable stream");
    let writer: WritableStreamDefaultWriter<Uint8Array>;
    try {
      const writable = port.writable;
      if (!writable) throw new Error("the port opened without a writable stream");
      writer = writable.getWriter();
    } catch (error) {
      reader.releaseLock();
      throw error;
    }
    link = new SerialBoardLink(port, session, reader, writer, env.clock, hooks.onLost);
    if ((await handshake(link, session, env.clock)) && link.markReady()) return link;
  } catch (error) {
    console.warn(`[board-link] probe at ${baud} baud failed:`, String(error));
  }
  if (link) {
    await link.disconnect();
  } else {
    try {
      await port.close();
    } catch {
      /* not open */
    }
  }
  return null;
}

/**
 * The Firmata probe: the handshake at each supported baud, on one fresh
 * detection codec. Returns a `ready` link, or null when no Firmata answered —
 * with the port closed either way it fails. With `afterFlash`, first wait for
 * the board to reboot into the new sketch, then fall back to the granted ports
 * newest-first: AVR109 boards re-enumerate as a new USB device after flashing,
 * which Web Serial models as a different granted port.
 *
 * The bring-up *policy* — when to probe, flash, retry or give up — lives in the
 * shared `microflow_core::bringup` machine; this is the transport primitive its
 * `probe` action runs.
 */
export async function probeBoard(
  env: ProbeEnv,
  port: WebSerialPort,
  hooks: ProbeHooks,
  options: { afterFlash: boolean },
): Promise<BoardConnection | null> {
  const probeOne = async (candidate: WebSerialPort): Promise<BoardConnection | null> => {
    const session = await env.createSession();
    for (const baud of BAUD_RATES) {
      const link = await tryConnectAtBaud(env, candidate, baud, session, hooks);
      if (link) return link;
    }
    return null;
  };
  if (!options.afterFlash) return probeOne(port);

  await env.clock.sleep(POST_FLASH_RESET_MS);
  const direct = await probeOne(port).catch(() => null);
  if (direct) return direct;
  for (const granted of (await env.listGrantedPorts()).slice().reverse()) {
    const link = await probeOne(granted).catch(() => null);
    if (link) return link;
  }
  return null;
}

/** The read loop's two outlets. */
export type PumpHooks = {
  /** Raw inbound bytes, after the detection codec has seen them. */
  onBytes?: (bytes: Uint8Array) => void;
  /** The reader ended: the port closed or the device went away. */
  onClosed?: () => void;
};

/**
 * Drain one reader into the detection codec and `onBytes` until it ends, then
 * fire `onClosed` exactly once. Every chunk goes to both, in that order and
 * without filtering — that identical stream is what keeps the detection codec's
 * pin table and the flow runtime's from drifting apart (ADR-0018).
 *
 * The only thing here that can mean *the port is gone* is `reader.read()`
 * rejecting or ending. Everything else in the loop is computation over a chunk
 * that already arrived: the codec is wasm (`session.feed`), and `onBytes`
 * crosses into the wasm flow runtime. Those faults are contained per chunk so
 * the loop keeps reading — a broken engine must never be reported as an
 * unplugged board (ADR-0017).
 */
export async function pumpReader(
  reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> },
  session: Pick<FirmataSession, "feed">,
  hooks: PumpHooks,
): Promise<void> {
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      try {
        // Advance the detection codec's own state — this is what makes
        // `firmwareName()` and `pinsJson()` answer during the handshake, and
        // keeps them truthful afterwards for `connectedState`. Its per-chunk
        // `FeedResult` report has no consumer in the browser (ADR-0018).
        session.feed(value);
      } catch (error) {
        console.warn("[board-link] detection codec rejected a chunk:", error);
      }
      try {
        hooks.onBytes?.(value);
      } catch (error) {
        console.error("[board-link] inbound-bytes handler threw:", error);
      }
    }
  } catch {
    // `reader.read()` rejected: the port closed or the device went away.
  }
  hooks.onClosed?.();
}
