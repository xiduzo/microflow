// The browser MIDI performer: Web MIDI I/O for the flow host — the browser twin
// of the desktop `MidiManager` (src-tauri/src/runtime/midi.rs).
//
// Like the CloudPerformer it is host-free: it never touches the wasm runtime;
// inbound messages re-enter through the injected {@link MidiDeliver} callback
// (the runtime's `deliverMessage`, `topic` = the port name, payload = the raw
// `[status, data1, data2]`). ALL parsing/filtering lives in core's
// `Midi::receive_raw_message` — this module only moves bytes.
//
// Web MIDI is Chromium-only (and needs a user permission grant); on browsers
// without it, reconcile/send log once and do nothing — mirroring how cloud
// nodes degrade without a configured broker.

import type { MidiListener } from "@/lib/runtime/wasm";

/** Route one raw inbound MIDI message to an in-node (`deliverMessage`). */
export type MidiDeliver = (nodeId: string, portName: string, bytes: Uint8Array) => void;

/** Case-insensitive substring match; an empty filter matches every port.
 *  Mirrors the desktop `device_matches` — the two hosts must agree. */
export function deviceMatches(portName: string, filter: string): boolean {
  return filter === "" || portName.toLowerCase().includes(filter.toLowerCase());
}

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
  private listeners: MidiListener[] = [];
  private access: MidiAccessLike | null = null;
  private accessPromise: Promise<MidiAccessLike> | null = null;
  private disposed = false;

  constructor(
    private readonly deliver: MidiDeliver,
    private readonly factory: MidiAccessFactory = defaultAccessFactory,
  ) {}

  /** Reconcile the flow's MIDI listeners: attach a message handler to every
   *  input some listener's filter matches, detach the rest. Access is requested
   *  on the first reconcile with listeners (the browser permission prompt). */
  reconcile(listeners: MidiListener[]): void {
    this.listeners = listeners;
    if (listeners.length === 0) {
      this.detach();
      return;
    }
    this.ensureAccess()
      .then(() => this.attach())
      .catch(() => {});
  }

  /** Write one raw message to every output whose port name matches
   *  `deviceName` ("" = all). */
  send(deviceName: string, bytes: number[]): void {
    this.ensureAccess()
      .then((access) => {
        if (this.disposed) return;
        for (const output of access.outputs.values()) {
          if (deviceMatches(output.name ?? "", deviceName)) {
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
        // the current listener set.
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
      const wanted = this.listeners.some((l) => deviceMatches(name, l.deviceName));
      input.onmidimessage = wanted ? (event) => this.onMessage(name, event) : null;
    }
  }

  /** Fan one inbound message out to every matching listener — several nodes
   *  listening to one device ALL receive it (no per-topic owner, unlike MQTT). */
  private onMessage(portName: string, event: MIDIMessageEvent): void {
    if (this.disposed || !event.data) return;
    for (const listener of this.listeners) {
      if (deviceMatches(portName, listener.deviceName)) {
        this.deliver(listener.nodeId, portName, event.data);
      }
    }
  }

  private detach(): void {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = null;
    }
  }
}
