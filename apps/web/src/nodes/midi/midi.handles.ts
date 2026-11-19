import { defineHandles } from "../_base/handle-rule";
import type { Data } from "./midi.schema";

// An out node only sends (the runtime rejects `send` on an in node). An in
// node emits a control change on `value`, and notes on the four note handles.
// `song` is an out-only mode, so an in node set to it has nothing to offer.
export const handles = defineHandles<"Midi", Data>(
  (data) => {
    if (data.direction === "out") {
      return { ports: [{ id: "send", kind: "command" }], emits: [] };
    }
    if (data.mode === "cc") return { ports: [], emits: [{ id: "value", kind: "value" }] };
    if (data.mode === "song") return { ports: [], emits: [] };
    return {
      ports: [],
      emits: [
        { id: "note", kind: "value", offset: -1.5 },
        { id: "velocity", kind: "value", offset: -0.5 },
        { id: "on", kind: "command", offset: 0.5 },
        { id: "off", kind: "command", offset: 1.5 },
      ],
    };
  },
  {
    variants: [
      { direction: "out" },
      { direction: "in", mode: "note" },
      { direction: "in", mode: "cc" },
      { direction: "in", mode: "song" },
    ],
  },
);
