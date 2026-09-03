import { describe, expect, test } from "bun:test";
import type { Node } from "@xyflow/react";
import { buildCircuitCode } from "./circuit-builder";
import {
  COMPONENT_IMPL,
  COMPONENT_TYPES,
  REQUIRES_HARDWARE,
} from "@/components/flow/nodes/_base/_base.types";
import type { Pin } from "@/stores/board";

/** A node as the canvas stores it — only the fields the builder reads. */
function node(instance: string, data: Record<string, unknown> = {}): Node {
  return {
    id: `${instance}-1`,
    type: instance,
    position: { x: 0, y: 0 },
    data: { instance, label: instance, ...data },
  } as unknown as Node;
}

/** An Uno-shaped pin table: D0-D13 digital, A0-A5 as pins 14-19. */
const UNO: Pin[] = Array.from({ length: 20 }, (_, pin) => ({
  pin,
  analogChannel: pin >= 14 ? pin : 127,
  supportedModes: [0, 1, 2],
})) as unknown as Pin[];

describe("hardware gate follows the Component Catalog", () => {
  test("every hardware-backed entry reaches the part lookup", () => {
    const hardware = COMPONENT_TYPES.filter((t) => REQUIRES_HARDWARE[t]);
    expect(hardware.length).toBeGreaterThan(0);

    // Guards the drift this replaced: a hand-written name list that had grown
    // 8 entries out of date with `impls[].requiresHardware`. A node the gate
    // rejects yields neither a part nor an `unsupported` entry — it vanishes.
    for (const type of hardware) {
      const { componentCount, unsupported } = buildCircuitCode([node(type, { pin: 3 })], UNO);
      expect({ type, reached: componentCount + unsupported.length }).toEqual({ type, reached: 1 });
    }
  });

  test("the parts still missing artwork are named, and only those", () => {
    // Not drift — a real gap in `componentMap`. Pinned so adding a part (or a
    // new hardware node without one) is a deliberate, visible change.
    const missing = COMPONENT_TYPES.filter((t) => REQUIRES_HARDWARE[t]).filter(
      (t) => buildCircuitCode([node(t, { pin: 3 })], UNO).unsupported.length > 0,
    );
    expect(missing).toEqual(["I2cDevice", "Pn532", "Stepper"]);
  });

  test("a non-hardware node is not on the schematic at all", () => {
    const result = buildCircuitCode([node("Counter")], UNO);
    expect(result.componentCount).toBe(0);
    expect(result.unsupported).toEqual([]);
    expect(result.code).not.toContain("MCU");
  });
});

describe("Variants resolve through their impl", () => {
  // Force/HallEffect/Tilt reuse `Sensor`; Vibration reuses `Led`. None of them
  // has its own artwork, and none should need a row in the part map.
  test.each([
    ["Force", "Sensor", "<jumper"],
    ["HallEffect", "Sensor", "<jumper"],
    ["Tilt", "Sensor", "<jumper"],
    ["Vibration", "Led", "<led"],
  ])("%s draws as its impl %s", (variant, impl, marker) => {
    expect(COMPONENT_IMPL[variant as keyof typeof COMPONENT_IMPL]).toBe(impl);

    const asVariant = buildCircuitCode([node(variant, { pin: 3 })], UNO);
    expect(asVariant.componentCount).toBe(1);
    expect(asVariant.unsupported).toEqual([]);
    expect(asVariant.code).toContain(marker);
  });

  test("a Variant with its own artwork keeps it over the impl fallback", () => {
    // Ldr resolves to the Sensor impl (drawn as <jumper>), but carries
    // subType "ldr", which the part map has a dedicated <resistor> row for.
    // The subType lookup must win.
    expect(COMPONENT_IMPL.Ldr).toBe("Sensor");

    const result = buildCircuitCode([node("Ldr", { pin: "A0", subType: "ldr" })], UNO);
    expect(result.componentCount).toBe(1);
    expect(result.code).toContain("<resistor");
    expect(result.code).not.toContain("<jumper");
  });
});

describe("pin resolution", () => {
  test("an analog pin string resolves through the board's pin table", () => {
    const result = buildCircuitCode([node("Sensor", { pin: "A0", subType: "sensor" })], UNO);
    // A0 is pin 14 on this table, and the MCU labels it back as A0.
    expect(result.code).toContain('pin1: "A0"');
  });

  test("with no board connected it falls back to the Uno mapping", () => {
    const result = buildCircuitCode([node("Sensor", { pin: "A0", subType: "sensor" })], []);
    expect(result.componentCount).toBe(1);
    // No pin table to format against, so the label comes from the Uno fallback.
    expect(result.code).toContain('pin1: "A0"');
  });
});

describe("unsupported parts are reported, not dropped", () => {
  test("a hardware node with no part is named in the result", () => {
    const result = buildCircuitCode([node("Stepper", { pin: 3 })], UNO);
    expect(result.unsupported).toEqual(["Stepper"]);
    expect(result.componentCount).toBe(0);
  });

  test("a drawable node beside an unsupported one still draws", () => {
    const result = buildCircuitCode(
      [node("Stepper", { pin: 3 }), node("Led", { pin: 5, subType: "led" })],
      UNO,
    );
    expect(result.unsupported).toEqual(["Stepper"]);
    expect(result.componentCount).toBe(1);
  });
});
