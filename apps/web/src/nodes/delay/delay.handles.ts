import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Delay">(() => ({
  ports: [{ id: "trigger", kind: "command" }],
  emits: [{ id: "event", kind: "event" }],
}));
