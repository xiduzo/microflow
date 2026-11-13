// The seam between the board link and the browser's Web Serial API.
//
// Everything the link does to a port goes through `WebSerialPort`, and every
// port it learns about comes from a `WebSerial` (the `navigator.serial` shape).
// The production adapter is `browserSerial()`; tests bind fakes that script the
// inbound bytes, throw on write, and fire connect/disconnect — which is what
// makes the open/probe/lost/closed lifecycle testable without a browser.
//
// The TS DOM lib does not ship Web Serial typings, so these are the minimal
// structural subset the link uses.

export interface WebSerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface WebSerialOptions {
  baudRate: number;
  bufferSize?: number;
}

export interface WebSerialSignals {
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

/** `navigator.serial`: the port source, plus `connect`/`disconnect` events for
 *  already-granted devices. */
export interface WebSerial {
  requestPort(): Promise<WebSerialPort>;
  getPorts(): Promise<WebSerialPort[]>;
  addEventListener(type: "connect" | "disconnect", listener: (event: Event) => void): void;
  removeEventListener(type: "connect" | "disconnect", listener: (event: Event) => void): void;
}

/** The Web Serial entry point, or undefined outside Chromium browsers. */
export function browserSerial(): WebSerial | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as unknown as { serial?: WebSerial }).serial;
}

export type ConnectivityHandlers = {
  onConnect?: (port: WebSerialPort) => void;
  onDisconnect?: (port: WebSerialPort) => void;
};

/**
 * Subscribe to `serial`'s connect/disconnect events for already-granted
 * devices. Returns an unsubscribe; a no-op when `serial` is undefined.
 */
export function watchConnectivity(
  serial: WebSerial | undefined,
  handlers: ConnectivityHandlers,
): () => void {
  if (!serial) return () => {};
  // Chromium dispatches these on `navigator.serial` with the port as the
  // event's target; the spec'd `SerialConnectionEvent` also carries `.port`.
  const portOf = (event: Event): WebSerialPort =>
    (event as unknown as { port?: WebSerialPort }).port ??
    (event.target as unknown as WebSerialPort);
  const onConnect = (event: Event) => handlers.onConnect?.(portOf(event));
  const onDisconnect = (event: Event) => handlers.onDisconnect?.(portOf(event));
  serial.addEventListener("connect", onConnect);
  serial.addEventListener("disconnect", onDisconnect);
  return () => {
    serial.removeEventListener("connect", onConnect);
    serial.removeEventListener("disconnect", onDisconnect);
  };
}
