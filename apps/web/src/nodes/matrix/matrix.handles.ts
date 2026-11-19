import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Matrix">(() => ({
  ports: [
    { id: "value", kind: "value", offset: -1, hint: "shape #" },
    { id: "reset", kind: "command", offset: 0 },
    { id: "reinitialize", kind: "command", offset: 1, hint: "set the display up again" },
  ],
  emits: [{ id: "value", kind: "value" }],
}));
