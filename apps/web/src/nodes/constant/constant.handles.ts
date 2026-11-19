import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Constant">(() => ({
  ports: [],
  emits: [{ id: "value", kind: "value" }],
}));
