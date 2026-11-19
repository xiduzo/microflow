import { defineHandles } from "../_base/handle-rule";

// Also the rule of the Variants that render through `Sensor`: Force,
// HallEffect, Ldr, Potentiometer and Tilt.
export const handles = defineHandles<"Sensor">(() => ({
  ports: [],
  emits: [{ id: "value", kind: "value" }],
}));
