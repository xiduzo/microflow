import { defineHandles } from "../_base/handle-rule";

// The component also declares the Port `key_event`. The host delivers key
// presses on it; it is not offered for edges.
export const handles = defineHandles<"Hotkey">(() => ({
  ports: [],
  emits: [
    { id: "event", kind: "event", offset: -1 },
    { id: "true", kind: "state", offset: 0 },
    { id: "false", kind: "state", offset: 1 },
  ],
}));
