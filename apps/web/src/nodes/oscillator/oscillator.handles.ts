import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Oscillator">(() => ({
  ports: [
    { id: "start", kind: "command", offset: -1 },
    { id: "reset", kind: "command" },
    { id: "stop", kind: "command", offset: 1 },
  ],
  emits: [{ id: "value", kind: "value" }],
}));
