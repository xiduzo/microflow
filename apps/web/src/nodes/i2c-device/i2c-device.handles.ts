import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"I2cDevice">(() => ({
  ports: [
    { id: "write", kind: "value", offset: -0.5, hint: "write bytes" },
    { id: "trigger", kind: "command", offset: 0.5, hint: "one-shot read" },
  ],
  emits: [{ id: "value", kind: "value" }],
}));
