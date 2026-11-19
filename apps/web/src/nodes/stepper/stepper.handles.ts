import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Stepper">(() => ({
  ports: [
    { id: "value", kind: "value", offset: -2, hint: "steps (±)" },
    { id: "to", kind: "value", offset: -1, hint: "go to position" },
    { id: "stop", kind: "command", offset: 0 },
    { id: "zero", kind: "command", offset: 1, hint: "reset position" },
    { id: "enable", kind: "value", offset: 2, hint: "true holds the motor, false releases it" },
  ],
  emits: [],
}));
