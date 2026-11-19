import { describe, expect, test } from "bun:test";
import type { FlowNode } from "@microflow/collab";
import { hotkeyAccelerators } from "./hotkey-accelerators";

// What the host registers with the keyboard. Which nodes hear a key is core's
// `dispatch_key_event` (Rust tests); this only has to name each key once.

function node(id: string, instance: string, data: Record<string, unknown> = {}): FlowNode {
  return {
    id,
    type: instance,
    position: { x: 0, y: 0 },
    data: { instance, ...data },
  } as unknown as FlowNode;
}

describe("hotkeyAccelerators", () => {
  test("names the accelerator of every Hotkey node and nothing else", () => {
    const accelerators = hotkeyAccelerators([
      node("hk-1", "Hotkey", { accelerator: "x" }),
      node("led", "Led", { pin: 13 }),
      node("hk-2", "Hotkey", { accelerator: "Mod+K" }),
      node("hk-unset", "Hotkey", { accelerator: "" }),
    ]);

    expect(accelerators).toEqual(["x", "Mod+K"]);
  });

  test("registers a key once however many nodes listen on it", () => {
    const accelerators = hotkeyAccelerators([
      node("hk-1", "Hotkey", { accelerator: "x" }),
      node("hk-2", "Hotkey", { accelerator: "x" }),
    ]);

    expect(accelerators).toEqual(["x"]);
  });

  test("registers a key once when nodes spell it in different case", () => {
    // The runtime matches accelerators case-insensitively: two registrations
    // would deliver one press to both nodes twice.
    const accelerators = hotkeyAccelerators([
      node("hk-1", "Hotkey", { accelerator: "Mod+K" }),
      node("hk-2", "Hotkey", { accelerator: "mod+k" }),
    ]);

    expect(accelerators).toEqual(["Mod+K"]);
  });
});
