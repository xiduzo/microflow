import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Monitor">(() => ({
  ports: [{ id: "value", kind: "value" }],
  emits: [],
}));
