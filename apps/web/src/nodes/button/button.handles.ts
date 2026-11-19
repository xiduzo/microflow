import { defineHandles } from "../_base/handle-rule";

// The component also emits its state on the implicit `value` Emit, which is
// what `event` carries; it is not offered.
export const handles = defineHandles<"Button">(() => ({
  ports: [],
  emits: [
    { id: "event", kind: "event", offset: -1.5 },
    { id: "true", kind: "state", offset: -0.5 },
    { id: "false", kind: "state", offset: 0.5 },
    { id: "hold", kind: "event", offset: 1.5, hint: "long press" },
  ],
}));
