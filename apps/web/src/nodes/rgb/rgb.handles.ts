import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Rgb">(() => ({
  ports: [
    { id: "red", kind: "value", offset: -2, hint: "0-255" },
    { id: "green", kind: "value", offset: -1, hint: "0-255" },
    { id: "blue", kind: "value", offset: 0, hint: "0-255" },
    { id: "alpha", kind: "value", offset: 1, hint: "0-100" },
    { id: "off", kind: "command", offset: 2 },
  ],
  emits: [{ id: "value", kind: "value" }],
}));
