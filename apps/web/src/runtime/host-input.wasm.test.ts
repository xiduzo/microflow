// Host input fan-out lives in core (`runtime::host_input`), so the browser host
// gets the desktop's behaviour by construction — this pins that claim against
// the *compiled* wasm module, through the RuntimeBridge the reactor uses: a key
// and a MIDI message go in without a node id, and core picks the nodes.
//
// Needs the generated module: `bun run build:wasm:runtime`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { FlowUpdate } from "@/lib/bindings/FlowUpdate";
import { FlowRuntime, initSync } from "./generated/microflow_runtime_wasm.js";
import { RuntimeBridge, type RuntimeFault } from "./runtime-bridge";

initSync({
  module: readFileSync(new URL("./generated/microflow_runtime_wasm_bg.wasm", import.meta.url)),
});

const node = (id: string, type: string, data: Record<string, unknown>) => ({
  id,
  type,
  data,
  position: { x: 0, y: 0 },
});

function bridgeFor(flow: FlowUpdate) {
  const faults: RuntimeFault[] = [];
  const runtime = new FlowRuntime();
  const bridge = new RuntimeBridge(runtime, (fault) => faults.push(fault));
  bridge.updateFlow(flow, 0);
  return { bridge, faults, free: () => runtime.free() };
}

describe("wasm runtime host input", () => {
  test("a key reaches every Hotkey node listening on it, in node-id order", () => {
    const { bridge, faults, free } = bridgeFor({
      nodes: [
        node("hk-b", "Hotkey", { accelerator: "Mod+K" }),
        node("hk-a", "Hotkey", { accelerator: "mod+k" }),
        node("hk-other", "Hotkey", { accelerator: "x" }),
      ],
      edges: [],
    });

    const pressed = bridge.keyEvent("Mod+K", true, 1);
    expect(pressed?.componentEvents.map((e) => `${e.source}.${e.sourceHandle}`)).toEqual([
      "hk-a.value",
      "hk-a.event",
      "hk-a.true",
      "hk-b.value",
      "hk-b.event",
      "hk-b.true",
    ]);

    const released = bridge.keyEvent("Mod+K", false, 2);
    expect(released?.componentEvents.map((e) => `${e.source}.${e.sourceHandle}`)).toEqual([
      "hk-a.value",
      "hk-a.event",
      "hk-a.false",
      "hk-b.value",
      "hk-b.event",
      "hk-b.false",
    ]);

    // A key nothing listens on is a turn with no effects.
    expect(bridge.keyEvent("y", true, 3)).toBeUndefined();
    expect(faults).toEqual([]);
    free();
  });

  test("the runtime answers which MIDI inputs are wanted and fans a message out", () => {
    const { bridge, faults, free } = bridgeFor({
      nodes: [
        node("m-pad", "Midi", { direction: "in", deviceName: "launchpad" }),
        node("m-all", "Midi", { direction: "in", deviceName: "" }),
        node("m-out", "Midi", { direction: "out", deviceName: "synth" }),
      ],
      edges: [],
    });

    expect(bridge.listensToMidi()).toBe(true);
    expect(bridge.wantsMidiInput("Launchpad Mini")).toBe(true);
    expect(bridge.wantsMidiInput("Keystation 49")).toBe(true);
    expect(bridge.midiDeviceMatches("Micro Synth", "SYNTH")).toBe(true);
    expect(bridge.midiDeviceMatches("Drum Machine", "synth")).toBe(false);

    const note = Uint8Array.from([0x90, 60, 100]);
    const fromPad = bridge.midiMessage("Launchpad Mini", note, 1);
    expect([...new Set(fromPad?.componentEvents.map((e) => e.source))]).toEqual([
      "m-all",
      "m-pad",
    ]);
    const fromKeys = bridge.midiMessage("Keystation 49", note, 2);
    expect([...new Set(fromKeys?.componentEvents.map((e) => e.source))]).toEqual(["m-all"]);
    expect(faults).toEqual([]);
    free();
  });

  test("a flow with no Midi in-node listens to nothing", () => {
    const { bridge, free } = bridgeFor({
      nodes: [node("m-out", "Midi", { direction: "out", deviceName: "" })],
      edges: [],
    });

    expect(bridge.listensToMidi()).toBe(false);
    expect(bridge.wantsMidiInput("Launchpad Mini")).toBe(false);
    expect(bridge.midiMessage("Launchpad Mini", Uint8Array.from([0x90, 60, 100]), 1)).toBeUndefined();
    free();
  });
});
