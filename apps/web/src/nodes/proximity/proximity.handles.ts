import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Proximity">(() => ({
  ports: [],
  emits: [{ id: "value", kind: "value" }],
}));
