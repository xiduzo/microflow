import { defineHandles } from "../_base/handle-rule";
import type { Data } from "./piezo.schema";

// Both types have the same Ports; only what `trigger` is called differs.
export const handles = defineHandles<"Piezo", Data>((data) => ({
  ports: [
    {
      id: "trigger",
      kind: "command",
      offset: -0.5,
      ...(data.type === "song" && { title: "play" }),
    },
    { id: "stop", kind: "command", offset: 0.5 },
  ],
  // Whether it is sounding: true from `trigger` until the buzz or song ends or `stop`.
  emits: [{ id: "value", kind: "value" }],
}));
