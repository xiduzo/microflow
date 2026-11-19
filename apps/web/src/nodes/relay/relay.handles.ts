import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Relay">(() => ({
  ports: [
    { id: "true", kind: "command", offset: -1 },
    { id: "toggle", kind: "command" },
    { id: "false", kind: "command", offset: 1 },
  ],
  // Whether the relay is open, like Led's `value`.
  emits: [{ id: "value", kind: "value" }],
}));
