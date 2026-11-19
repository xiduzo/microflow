import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"RangeMap">(() => ({
  ports: [{ id: "value", kind: "value" }],
  emits: [{ id: "to", kind: "value" }],
}));
