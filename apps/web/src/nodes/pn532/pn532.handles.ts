import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Pn532">(() => ({
  ports: [],
  emits: [{ id: "value", kind: "value" }],
}));
