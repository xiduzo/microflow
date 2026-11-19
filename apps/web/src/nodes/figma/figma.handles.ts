import { defineHandles, type PortSpec } from "../_base/handle-rule";
import type { Data } from "./figma.schema";

type ResolvedType = Data["resolvedType"];

/** The Ports that make sense for a design variable of each type. */
const PORTS: Record<ResolvedType, readonly PortSpec<"Figma">[]> = {
  BOOLEAN: [{ id: "true", offset: -1 }, { id: "toggle" }, { id: "false", offset: 1 }],
  COLOR: [
    { id: "red", offset: -1.5, hint: "0-255" },
    { id: "green", offset: -0.5, hint: "0-255" },
    { id: "blue", offset: 0.5, hint: "0-255" },
    { id: "opacity", offset: 1.5, hint: "0-100" },
  ],
  FLOAT: [
    { id: "increment", offset: -1.5 },
    { id: "set", offset: -0.5 },
    { id: "decrement", offset: 0.5 },
    { id: "reset", offset: 1.5 },
  ],
  STRING: [{ id: "set" }],
};

/** Own keys only: `"toString"` is not a variable type. */
const isResolvedType = (value: unknown): value is ResolvedType =>
  typeof value === "string" && Object.hasOwn(PORTS, value);

// The Ports follow the type stored on the node (`resolvedType`), which the
// variable picker writes together with the variable. So the handles, and their
// edges, stay while the design tool's plugin is closed, and a template's edges
// attach before a variable is picked.
export const handles = defineHandles<"Figma", Data>(
  (data) => ({
    ports: PORTS[isResolvedType(data.resolvedType) ? data.resolvedType : "STRING"],
    emits: [{ id: "change" }],
  }),
  {
    variants: [
      { resolvedType: "BOOLEAN" },
      { resolvedType: "COLOR" },
      { resolvedType: "FLOAT" },
      { resolvedType: "STRING" },
    ],
    // Nobody sets `resolvedType`: the variable picker in the node's settings
    // fills it in from the variable that is picked.
    variantsFollow: "the type of the design variable the user picks in the node's settings",
  },
);
