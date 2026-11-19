import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Smooth">(() => ({
  ports: [{ id: "value", kind: "value" }],
  emits: [{ id: "value", kind: "value" }],
}));
