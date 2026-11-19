import { defineHandles } from "../_base/handle-rule";
import type { Data } from "./mqtt.schema";

// A node either publishes (one Port) or subscribes (one Emit). The runtime
// rejects `trigger` on a subscribing node, and a publishing node never emits.
export const handles = defineHandles<"Mqtt", Data>(
  (data) =>
    data.direction === "publish"
      ? { ports: [{ id: "trigger", kind: "command" }], emits: [] }
      : { ports: [], emits: [{ id: "value", kind: "value" }] },
  { variants: [{ direction: "publish" }, { direction: "subscribe" }] },
);
