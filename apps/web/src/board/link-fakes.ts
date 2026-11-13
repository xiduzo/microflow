// Fake adapters for the board link's seams — `Clock`, `WebSerialPort`,
// `WebSerial` (navigator.serial) and the detection codec — so the whole
// open → probe → ready/attached → lost → closed lifecycle runs in bun:test with
// no browser, no board and no wasm. Test support only: nothing in the app
// imports this module.
//
// The fake port keeps the two Web Serial behaviours the link's cleanup exists
// for: `open` on an open port rejects ("The port is already open."), and
// `close` rejects while either stream is still locked.

import type { Clock, TimerHandle } from "./clock";
import type { FirmataSession } from "./wasm";
import type { WebSerial, WebSerialOptions, WebSerialPort, WebSerialPortInfo } from "./serial-port";

// --- Clock ------------------------------------------------------------------

type FakeTimer = { id: number; at: number; fn: () => void };

/** Let every pending promise chain (streams included) run to quiescence. */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Virtual time. Nothing fires until the test advances it. */
export class FakeClock implements Clock {
  private time = 0;
  private nextId = 1;
  private timers: FakeTimer[] = [];
  /** Every delay handed to `setTimer`/`sleep`, in call order. */
  readonly scheduled: number[] = [];

  now(): number {
    return this.time;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimer(resolve, ms);
    });
  }

  setTimer(fn: () => void, ms: number): TimerHandle {
    const timer = { id: this.nextId++, at: this.time + ms, fn };
    this.timers.push(timer);
    this.scheduled.push(ms);
    return timer.id;
  }

  clearTimer(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Fire the earliest timer, jumping time to it. False when none is pending. */
  private fireNext(): boolean {
    if (this.timers.length === 0) return false;
    this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const timer = this.timers.shift()!;
    this.time = Math.max(this.time, timer.at);
    timer.fn();
    return true;
  }

  /** Advance by `ms`, firing every timer due on the way (flushing between). */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    await flush();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.fireNext();
      await flush();
    }
    this.time = target;
  }

  /** Fire timers in order until `predicate` holds. Throws when it still does
   *  not with no timer left to fire. */
  async until(predicate: () => boolean, maxSteps = 100_000): Promise<void> {
    for (let step = 0; step < maxSteps; step += 1) {
      await flush();
      if (predicate()) return;
      if (!this.fireNext()) {
        await flush();
        if (predicate()) return;
        throw new Error("FakeClock.until: condition unmet with no timers left");
      }
    }
    throw new Error("FakeClock.until: step limit reached");
  }

  /** Fire timers in order until `promise` settles; its value. */
  async run<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    const tracked = promise.finally(() => {
      settled = true;
    });
    await this.until(() => settled);
    return tracked;
  }
}

// --- Detection codec ---------------------------------------------------------

/** Query/response markers the fake device and fake codec agree on. */
export const FAKE_QUERY_FIRMWARE = 0x79;
export const FAKE_QUERY_CAPABILITIES = 0x6b;
export const FAKE_CAPABILITY_RESPONSE = 0x6c;

/** A stand-in detection codec: learns the firmware name from a chunk starting
 *  `0x79`, and a 20-pin table from one starting `0x6c`. */
export class FakeSession {
  readonly fed: Uint8Array[] = [];
  private name = "";
  private pins = 0;

  feed(bytes: Uint8Array): string {
    this.fed.push(bytes);
    if (bytes[0] === FAKE_QUERY_FIRMWARE) this.name = "StandardFirmata.ino";
    if (bytes[0] === FAKE_CAPABILITY_RESPONSE) this.pins = 20;
    return "{}";
  }
  firmwareName(): string {
    return this.name;
  }
  firmwareVersion(): string {
    return "2.5";
  }
  pinsJson(): string {
    return JSON.stringify(Array.from({ length: this.pins }, (_, pin) => ({ pin })));
  }
  encodeQueryFirmware(): Uint8Array {
    return Uint8Array.of(0xf0, FAKE_QUERY_FIRMWARE, 0xf7);
  }
  encodeQueryCapabilities(): Uint8Array {
    return Uint8Array.of(0xf0, FAKE_QUERY_CAPABILITIES, 0xf7);
  }
  encodeQueryAnalogMapping(): Uint8Array {
    return Uint8Array.of(0xf0, 0x69, 0xf7);
  }
  encodeDigitalWrite(pin: number, _value: boolean): Uint8Array {
    return Uint8Array.of(0x90 | (pin >> 3), 0, 0);
  }
  /** Mirrors core's `encode_safe_state`: ports to 0, `SYSTEM_RESET`, ports to 0. */
  encodeSafeState(): Uint8Array {
    const ports: number[] = [];
    for (let port = 0; port * 8 < this.pins; port += 1) ports.push(0x90 | port, 0, 0);
    return Uint8Array.from([...ports, 0xff, ...ports]);
  }

  /** Typed as the wasm class the link takes. */
  asSession(): FirmataSession {
    return this as unknown as FirmataSession;
  }
}

// --- Port -------------------------------------------------------------------

/** The board at the other end of a fake port. */
export interface FakeDevice {
  /** Chunks the board sends back in answer to one written chunk. */
  respond(written: Uint8Array): Uint8Array[];
  /** Return true to make this write reject (the device went away mid-write). */
  failWrite?(written: Uint8Array): boolean;
}

/** A board running Firmata: answers the firmware and capability queries. */
export function firmataDevice(): FakeDevice {
  return {
    respond: (written) => {
      if (written[1] === FAKE_QUERY_FIRMWARE) return [Uint8Array.of(FAKE_QUERY_FIRMWARE, 2, 5)];
      if (written[1] === FAKE_QUERY_CAPABILITIES) return [Uint8Array.of(FAKE_CAPABILITY_RESPONSE)];
      return [];
    },
  };
}

/** A serial device that never answers. */
export function silentDevice(): FakeDevice {
  return { respond: () => [] };
}

export class FakeSerialPort implements WebSerialPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  isOpen = false;
  opens = 0;
  closes = 0;
  /** Every chunk the host wrote, across opens. */
  readonly written: Uint8Array[] = [];
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(
    public device: FakeDevice = firmataDevice(),
    private readonly info: WebSerialPortInfo = { usbVendorId: 0x2341, usbProductId: 0x0043 },
  ) {}

  async open(_options: WebSerialOptions): Promise<void> {
    if (this.isOpen) throw new DOMException("The port is already open.", "InvalidStateError");
    this.isOpen = true;
    this.opens += 1;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.device.failWrite?.(chunk)) {
          throw new DOMException("The device has been lost.", "NetworkError");
        }
        this.written.push(chunk);
        for (const reply of this.device.respond(chunk)) {
          queueMicrotask(() => this.emit(reply));
        }
      },
    });
  }

  async close(): Promise<void> {
    if (!this.isOpen) throw new DOMException("The port is already closed.", "InvalidStateError");
    if (this.readable?.locked || this.writable?.locked) {
      throw new TypeError("Cannot close a port while its streams are locked.");
    }
    this.isOpen = false;
    this.closes += 1;
    this.readable = null;
    this.writable = null;
    this.controller = null;
  }

  getInfo(): WebSerialPortInfo {
    return this.info;
  }

  async setSignals(): Promise<void> {}

  /** The board sends `bytes`. */
  emit(bytes: Uint8Array): void {
    try {
      this.controller?.enqueue(bytes);
    } catch {
      /* stream already closed */
    }
  }

  /** The device vanishes: a pending `read()` rejects. */
  unplug(): void {
    try {
      this.controller?.error(new DOMException("The device has been lost.", "NetworkError"));
    } catch {
      /* stream already closed */
    }
  }
}

// --- navigator.serial --------------------------------------------------------

export class FakeSerial implements WebSerial {
  private readonly target = new EventTarget();
  /** What the picker returns; null means the user dismissed it. */
  picked: WebSerialPort | null = null;

  constructor(public granted: WebSerialPort[] = []) {}

  async requestPort(): Promise<WebSerialPort> {
    if (!this.picked) throw new DOMException("No port selected by the user.", "NotFoundError");
    return this.picked;
  }

  async getPorts(): Promise<WebSerialPort[]> {
    return [...this.granted];
  }

  addEventListener(type: "connect" | "disconnect", listener: (event: Event) => void): void {
    this.target.addEventListener(type, listener);
  }

  removeEventListener(type: "connect" | "disconnect", listener: (event: Event) => void): void {
    this.target.removeEventListener(type, listener);
  }

  /** Fire `connect`/`disconnect` for `port`, as Chromium does on plug/unplug. */
  fire(type: "connect" | "disconnect", port: WebSerialPort): void {
    const event = new Event(type);
    Object.defineProperty(event, "port", { value: port });
    this.target.dispatchEvent(event);
  }
}
