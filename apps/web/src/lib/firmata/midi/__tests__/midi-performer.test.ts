// MidiPerformer unit tests: a stub MidiAccessFactory, fake input/output ports,
// no runtime — mirroring the cloud-performer tests. The performer only moves
// bytes; parsing/filtering is core's `Midi::receive_raw_message` (Rust tests).

import { describe, expect, it } from "bun:test";
import { deviceMatches, MidiPerformer, type MidiAccessLike } from "../midi-performer";

type Delivery = { nodeId: string; portName: string; bytes: number[] };

function fakeInput(name: string) {
  const input = {
    name,
    onmidimessage: null as ((event: { data: Uint8Array }) => void) | null,
    emit(bytes: number[]) {
      this.onmidimessage?.({ data: Uint8Array.from(bytes) });
    },
  };
  return input;
}

function fakeOutput(name: string) {
  const sent: number[][] = [];
  return { name, sent, send: (bytes: number[]) => sent.push([...bytes]) };
}

function setup(inputs: ReturnType<typeof fakeInput>[], outputs: ReturnType<typeof fakeOutput>[] = []) {
  const access: MidiAccessLike = {
    inputs: new Map(inputs.map((i) => [i.name, i as unknown as MIDIInput])),
    outputs: new Map(outputs.map((o) => [o.name, o as unknown as MIDIOutput])),
    onstatechange: null,
  };
  const deliveries: Delivery[] = [];
  const performer = new MidiPerformer(
    (nodeId, portName, bytes) => deliveries.push({ nodeId, portName, bytes: [...bytes] }),
    () => Promise.resolve(access),
  );
  return { access, deliveries, performer };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("deviceMatches", () => {
  it("empty filter matches everything, otherwise case-insensitive substring", () => {
    expect(deviceMatches("Launchpad Mini MK3", "")).toBe(true);
    expect(deviceMatches("Launchpad Mini MK3", "launchpad")).toBe(true);
    expect(deviceMatches("Launchpad Mini MK3", "push")).toBe(false);
  });
});

describe("MidiPerformer", () => {
  it("attaches to matching inputs and fans a message out to every matching listener", async () => {
    const pad = fakeInput("Launchpad Mini");
    const keys = fakeInput("Keystation 49");
    const { deliveries, performer } = setup([pad, keys]);

    performer.reconcile([
      { nodeId: "n1", deviceName: "launchpad" },
      { nodeId: "n2", deviceName: "" },
    ]);
    await tick();

    pad.emit([0x90, 60, 100]);
    expect(deliveries).toEqual([
      { nodeId: "n1", portName: "Launchpad Mini", bytes: [0x90, 60, 100] },
      { nodeId: "n2", portName: "Launchpad Mini", bytes: [0x90, 60, 100] },
    ]);

    deliveries.length = 0;
    keys.emit([0xb0, 1, 42]);
    // Only the "" (all devices) listener matches the Keystation.
    expect(deliveries).toEqual([
      { nodeId: "n2", portName: "Keystation 49", bytes: [0xb0, 1, 42] },
    ]);
  });

  it("detaches handlers when the flow has no listeners left", async () => {
    const pad = fakeInput("Launchpad Mini");
    const { deliveries, performer } = setup([pad]);

    performer.reconcile([{ nodeId: "n1", deviceName: "" }]);
    await tick();
    expect(pad.onmidimessage).not.toBeNull();

    performer.reconcile([]);
    expect(pad.onmidimessage).toBeNull();
    pad.emit([0x90, 60, 100]);
    expect(deliveries).toEqual([]);
  });

  it("sends to every matching output and none other", async () => {
    const synth = fakeOutput("Micro Synth");
    const drums = fakeOutput("Drum Machine");
    const { performer } = setup([], [synth, drums]);

    performer.send("synth", [0xb0, 7, 127]);
    await tick();
    expect(synth.sent).toEqual([[0xb0, 7, 127]]);
    expect(drums.sent).toEqual([]);

    performer.send("", [0x90, 60, 100]);
    await tick();
    expect(synth.sent).toHaveLength(2);
    expect(drums.sent).toEqual([[0x90, 60, 100]]);
  });

  it("drops deliveries after dispose", async () => {
    const pad = fakeInput("Launchpad Mini");
    const { deliveries, performer } = setup([pad]);
    performer.reconcile([{ nodeId: "n1", deviceName: "" }]);
    await tick();

    performer.dispose();
    pad.emit([0x90, 60, 100]);
    expect(deliveries).toEqual([]);
  });

  it("degrades quietly when MIDI access is unavailable", async () => {
    const performer = new MidiPerformer(
      () => {
        throw new Error("must not deliver");
      },
      () => Promise.reject(new Error("Web MIDI unavailable")),
    );
    performer.reconcile([{ nodeId: "n1", deviceName: "" }]);
    performer.send("", [0x90, 60, 100]);
    await tick();
  });
});
