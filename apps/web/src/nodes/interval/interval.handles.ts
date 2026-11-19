import { defineHandles } from "../_base/handle-rule";

export const handles = defineHandles<"Interval">(() => ({
  ports: [
    { id: "start", kind: "command", offset: -0.5 },
    { id: "stop", kind: "command", offset: 0.5 },
  ],
  emits: [{ id: "event", kind: "event" }],
}));
