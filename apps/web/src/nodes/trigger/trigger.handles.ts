import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Trigger">(() => ({
  ports: [{ id: "value", kind: "value" }],
  emits: [{ id: "bang", kind: "event" }],
}));
