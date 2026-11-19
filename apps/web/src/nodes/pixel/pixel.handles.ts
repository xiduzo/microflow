import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Pixel">(() => ({
  ports: [
    { id: "value", kind: "value", offset: -1.5, hint: "preset #" },
    { id: "color", kind: "value", offset: -0.5, hint: "hex colors" },
    { id: "set", kind: "command", offset: 0.5, hint: "shift pixels" },
    { id: "reset", kind: "command", offset: 1.5 },
  ],
  emits: [{ id: "event", kind: "event" }],
}));
