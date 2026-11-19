// MidiPerformer unit tests: a stub MidiAccessFactory, fake input/output ports
// and a stand-in MidiRuntime — mirroring the cloud-performer tests. The
// performer only moves bytes: which ports are wanted, which nodes hear a
// message and the device-name rule are core's (`runtime::host_input`, Rust
// tests), so the stand-in answers them from plain sets.

import { describe, expect, it } from "bun:test";
import { MidiPerformer, type MidiAccessLike, type MidiRuntime } from "./midi-performer";

type Message = { portName: string; bytes: number[] };

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
  /** The input ports the flow wants, as the runtime would answer. */
  const wanted = new Set<string>();
  /** `deviceName -> output ports` a send reaches, as the runtime would answer. */
  const reaches = new Map<string, string[]>();
  const messages: Message[] = [];
  let accessRequests = 0;
  const runtime: MidiRuntime = {
    listens: () => wanted.size > 0,
    wantsInput: (portName) => wanted.has(portName),
    deviceMatches: (portName, deviceName) => reaches.get(deviceName)?.includes(portName) ?? false,
    message: (portName, bytes) => messages.push({ portName, bytes: [...bytes] }),
  };
  const performer = new MidiPerformer(runtime, () => {
    accessRequests += 1;
    return Promise.resolve(access);
  });
  return { access, wanted, reaches, messages, performer, accessRequests: () => accessRequests };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MidiPerformer", () => {
  it("listens to the inputs the runtime wants and hands each message over once", async () => {
    const pad = fakeInput("Launchpad Mini");
    const keys = fakeInput("Keystation 49");
    const { wanted, messages, performer } = setup([pad, keys]);

    wanted.add("Launchpad Mini");
    performer.reconcile();
    await tick();

    expect(pad.onmidimessage).not.toBeNull();
    expect(keys.onmidimessage).toBeNull();

    // One message in, one hand-over: the runtime fans it out to its nodes.
    pad.emit([0x90, 60, 100]);
    expect(messages).toEqual([{ portName: "Launchpad Mini", bytes: [0x90, 60, 100] }]);
  });

  it("follows the flow: a port no longer wanted is detached on the next reconcile", async () => {
    const pad = fakeInput("Launchpad Mini");
    const keys = fakeInput("Keystation 49");
    const { wanted, messages, performer } = setup([pad, keys]);

    wanted.add("Launchpad Mini");
    performer.reconcile();
    await tick();

    wanted.delete("Launchpad Mini");
    wanted.add("Keystation 49");
    performer.reconcile();
    await tick();

    pad.emit([0x90, 60, 100]);
    keys.emit([0xb0, 1, 42]);
    expect(messages).toEqual([{ portName: "Keystation 49", bytes: [0xb0, 1, 42] }]);
  });

  it("asks for MIDI access only once a flow listens", async () => {
    const pad = fakeInput("Launchpad Mini");
    const { wanted, performer, accessRequests } = setup([pad]);

    performer.reconcile();
    await tick();
    expect(accessRequests()).toBe(0);

    wanted.add("Launchpad Mini");
    performer.reconcile();
    performer.reconcile();
    await tick();
    expect(accessRequests()).toBe(1);
  });

  it("attaches a port that is plugged in later", async () => {
    const pad = fakeInput("Launchpad Mini");
    const { access, wanted, messages, performer } = setup([]);

    wanted.add("Launchpad Mini");
    performer.reconcile();
    await tick();

    (access.inputs as Map<string, MIDIInput>).set(pad.name, pad as unknown as MIDIInput);
    (access.onstatechange as () => void)();

    pad.emit([0x90, 60, 100]);
    expect(messages).toEqual([{ portName: "Launchpad Mini", bytes: [0x90, 60, 100] }]);
  });

  it("detaches handlers when the flow has no listeners left", async () => {
    const pad = fakeInput("Launchpad Mini");
    const { wanted, messages, performer } = setup([pad]);

    wanted.add("Launchpad Mini");
    performer.reconcile();
    await tick();
    expect(pad.onmidimessage).not.toBeNull();

    wanted.clear();
    performer.reconcile();
    expect(pad.onmidimessage).toBeNull();
    pad.emit([0x90, 60, 100]);
    expect(messages).toEqual([]);
  });

  it("sends to the outputs the runtime says the device name reaches, and none other", async () => {
    const synth = fakeOutput("Micro Synth");
    const drums = fakeOutput("Drum Machine");
    const { reaches, performer } = setup([], [synth, drums]);
    reaches.set("synth", ["Micro Synth"]);
    reaches.set("", ["Micro Synth", "Drum Machine"]);

    performer.send("synth", [0xb0, 7, 127]);
    await tick();
    expect(synth.sent).toEqual([[0xb0, 7, 127]]);
    expect(drums.sent).toEqual([]);

    performer.send("", [0x90, 60, 100]);
    await tick();
    expect(synth.sent).toHaveLength(2);
    expect(drums.sent).toEqual([[0x90, 60, 100]]);
  });

  it("drops messages after dispose", async () => {
    const pad = fakeInput("Launchpad Mini");
    const { wanted, messages, performer } = setup([pad]);
    wanted.add("Launchpad Mini");
    performer.reconcile();
    await tick();

    performer.dispose();
    pad.emit([0x90, 60, 100]);
    expect(messages).toEqual([]);
  });

  it("degrades quietly when MIDI access is unavailable", async () => {
    const performer = new MidiPerformer(
      {
        listens: () => true,
        wantsInput: () => true,
        deviceMatches: () => true,
        message: () => {
          throw new Error("must not deliver");
        },
      },
      () => Promise.reject(new Error("Web MIDI unavailable")),
    );
    performer.reconcile();
    performer.send("", [0x90, 60, 100]);
    await tick();
  });
});
