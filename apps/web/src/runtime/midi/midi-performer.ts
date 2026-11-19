// The browser MIDI performer: Web MIDI I/O for the flow host — the browser twin
// of the desktop `MidiManager` (src-tauri/src/runtime/midi.rs).
//
// It only moves bytes. Which inputs to listen to, which nodes hear a message
// and which outputs a send reaches are the runtime's answers (core's
// `runtime::host_input`, the same for both hosts); they arrive through the
// injected {@link MidiRuntime}, so like the CloudPerformer this module never
// touches the wasm runtime itself.
//
// Web MIDI is Chromium-only (and needs a user permission grant); on browsers
// without it, reconcile/send log once and do nothing — mirroring how cloud
// nodes degrade without a configured broker.

/** What the performer asks of the flow runtime. */
export type MidiRuntime = {
  /** Does any node of the flow listen to MIDI input? Access is only asked for
   *  (the browser permission prompt) when one does. */
  listens(): boolean;
  /** Does the flow want the input port `portName` listened to? */
  wantsInput(portName: string): boolean;
  /** Does a send addressed to `deviceName` reach the output port `portName`? */
  deviceMatches(portName: string, deviceName: string): boolean;
  /** Hand over one raw inbound message and the port it arrived on. */
  message(portName: string, bytes: Uint8Array): void;
};

/** The slice of `MIDIAccess` the performer uses — stubbed in tests. The port
 *  maps are the DOM maplikes' read surface, so a real `MIDIAccess` satisfies it
 *  structurally. */
export type MidiAccessLike = {
  inputs: { values(): Iterable<MIDIInput> };
  outputs: { values(): Iterable<MIDIOutput> };
  onstatechange: unknown;
};

/** Stubbed in tests; defaults to the real `navigator.requestMIDIAccess`. */
export type MidiAccessFactory = () => Promise<MidiAccessLike>;

function defaultAccessFactory(): Promise<MidiAccessLike> {
  if (typeof navigator === "undefined" || navigator.requestMIDIAccess === undefined) {
    console.warn("[midi-performer] Web MIDI is not available in this browser");
    return Promise.reject(new Error("Web MIDI unavailable"));
  }
  return navigator.requestMIDIAccess();
}

export class MidiPerformer {
  private access: MidiAccessLike | null = null;
  private accessPromise: Promise<MidiAccessLike> | null = null;
  private disposed = false;

  constructor(
    private readonly runtime: MidiRuntime,
    private readonly factory: MidiAccessFactory = defaultAccessFactory,
  ) {}

  /** Reconcile the inputs against the flow the runtime now runs: attach a
   *  message handler to every input it wants, detach the rest. Access is
   *  requested on the first reconcile of a flow that listens to MIDI. */
  reconcile(): void {
    if (!this.runtime.listens()) {
      this.detach();
      return;
    }
    this.ensureAccess()
      .then(() => this.attach())
      .catch(() => {});
  }

  /** Write one raw message to every output port `deviceName` addresses
   *  ("" = all). */
  send(deviceName: string, bytes: number[]): void {
    this.ensureAccess()
      .then((access) => {
        if (this.disposed) return;
        for (const output of access.outputs.values()) {
          if (this.runtime.deviceMatches(output.name ?? "", deviceName)) {
            output.send(bytes);
          }
        }
      })
      .catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
  }

  private ensureAccess(): Promise<MidiAccessLike> {
    if (this.accessPromise === null) {
      this.accessPromise = this.factory().then((access) => {
        this.access = access;
        // Hotplug: a device (dis)appearing re-runs handler attachment against
        // what the runtime wants now.
        access.onstatechange = () => this.attach();
        return access;
      });
      this.accessPromise.catch((error: unknown) => {
        console.warn("[midi-performer] MIDI access denied:", error);
      });
    }
    return this.accessPromise;
  }

  private attach(): void {
    if (!this.access || this.disposed) return;
    for (const input of this.access.inputs.values()) {
      const name = input.name ?? "";
      input.onmidimessage = this.runtime.wantsInput(name)
        ? (event) => this.onMessage(name, event)
        : null;
    }
  }

  private onMessage(portName: string, event: MIDIMessageEvent): void {
    if (this.disposed || !event.data) return;
    this.runtime.message(portName, event.data);
  }

  private detach(): void {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = null;
    }
  }
}
