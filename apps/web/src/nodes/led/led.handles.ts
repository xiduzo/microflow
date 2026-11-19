import { defineHandles } from "../_base/handle-rule";
import type { Data } from "./led.schema";

// Also the rule of the `Vibration` Variant, which renders through `Led`.
export const handles = defineHandles<"Led", Data>((data) => ({
  ports: [
    { id: "true", kind: "command", offset: -1.5 },
    { id: "toggle", kind: "command", offset: -0.5 },
    {
      id: "value",
      kind: "value",
      offset: 0.5,
      title: data.subType === "vibration" ? "intensity" : "brightness",
    },
    { id: "false", kind: "command", offset: 1.5 },
  ],
  emits: [{ id: "value", kind: "value" }],
}));
