import { defineHandles } from "../_base/handle-rule";
import type { Data } from "./servo.schema";

// The component also declares the Port `rotate`: the runtime treats it exactly
// like `value` on a continuous servo and rejects it on a standard one, so it is
// not offered beside `value`.
export const handles = defineHandles<"Servo", Data>(
  (data) => ({
    ports:
      data.type === "continuous"
        ? [
            { id: "value", kind: "value", offset: -0.5, hint: "from -1 to 1" },
            { id: "stop", kind: "command", offset: 0.5 },
          ]
        : [
            { id: "min", kind: "value", offset: -1 },
            { id: "value", kind: "value" },
            { id: "max", kind: "value", offset: 1 },
          ],
    emits: [{ id: "value", kind: "value" }],
  }),
  { variants: [{ type: "standard" }, { type: "continuous" }] },
);
