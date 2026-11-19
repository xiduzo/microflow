import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Counter">(() => ({
  ports: [
    { id: "increment", kind: "command", offset: -1.5, title: "+" },
    { id: "set", kind: "command", offset: -0.5 },
    { id: "decrement", kind: "command", offset: 0.5, title: "-" },
    { id: "reset", kind: "command", offset: 1.5 },
  ],
  emits: [{ id: "value", kind: "value" }],
}));
