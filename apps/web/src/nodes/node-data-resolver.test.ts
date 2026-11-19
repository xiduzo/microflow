import { describe, expect, test } from "bun:test";
import type { ComponentType } from "@/nodes/component-types.generated";
import { resolveNodeData } from "./node-data-resolver";

describe("a fraction in a whole-number setting", () => {
  // A flow may hold `25.2` where the Rust config holds a whole number: Leva
  // keeps a typed fraction whatever a control's `step` is (the step only
  // shapes dragging), and Ask AI and a flow file write any number. The Rust
  // config reads such a value as the nearest whole number
  // (`serde_utils::deserialize_whole`), so the node runs. A schema that
  // refused it (`.int()`) would stop Ask AI from editing that node and have
  // the flow file codec report its settings as unrecognised.
  const held: [ComponentType, string, number][] = [
    ["Proximity", "freq", 25.2],
    ["Sensor", "freq", 25.2],
    ["Sensor", "threshold", 1.5],
    ["Button", "holdtime", 500.5],
    ["Delay", "delay", 1000.5],
    ["Interval", "interval", 500.5],
    ["Trigger", "within", 250.5],
    ["Pixel", "length", 32.5],
    ["Matrix", "devices", 1.5],
    ["Midi", "tempo", 113.5],
    ["Pn532", "pollIntervalMs", 500.5],
    ["I2cDevice", "freq", 100.5],
    ["Stepper", "stepsPerRev", 200.5],
  ];

  test.each(held)("%s.%s stays readable", (type, field, value) => {
    const resolved = resolveNodeData(type, { [field]: value });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.data[field]).toBe(value);
  });
});

describe("the colour order of a Pixel strip", () => {
  // Most addressable strips (WS2812 / NeoPixel) are GRB, so that is what a new
  // strip gets. The default is written into the node's data when it is made,
  // so a strip that was made with another order keeps it.
  test("a new strip is GRB", () => {
    const resolved = resolveNodeData("Pixel", {});

    expect(resolved.ok && resolved.data.color_order).toBe("GRB");
  });

  test.each(["BRG", "RGB", "GRB"])("a strip stored as %s stays %s", (stored) => {
    // An edit of another setting resolves on top of what the node holds.
    const resolved = resolveNodeData("Pixel", { length: 8 }, { color_order: stored });

    expect(resolved.ok && resolved.data.color_order).toBe(stored);
  });
});
