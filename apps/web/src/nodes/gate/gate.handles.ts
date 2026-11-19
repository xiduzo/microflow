import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Gate">(() => ({
  ports: [{ id: "value", kind: "value" }],
  emits: [
    { id: "true", kind: "state", offset: -0.5 },
    { id: "false", kind: "state", offset: 0.5 },
  ],
}));
