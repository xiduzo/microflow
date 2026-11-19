import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Switch">(() => ({
  ports: [],
  emits: [
    { id: "event", kind: "event", offset: -1 },
    { id: "true", kind: "state" },
    { id: "false", kind: "state", offset: 1 },
  ],
}));
