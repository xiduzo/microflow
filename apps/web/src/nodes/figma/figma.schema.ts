import { z } from "zod";
import { DESIGN_TOOLS, RESOLVED_TYPES } from "@microflow/design-bridge";
import { baseDataSchema, rgbaSchema } from "../_base/_base.schema";

export const valueSchema = z.union([z.string(), z.number(), z.boolean(), rgbaSchema]);
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  /** The design tool the variable lives in. */
  source: z.enum(DESIGN_TOOLS).default("figma"),
  brokerId: z.string().default(""),
  /** The Bridge ID, patched in by the host adapter. */
  uniqueId: z.string().default(""),
  variableId: z.string().default(""),
  resolvedType: z.enum(RESOLVED_TYPES).default("STRING"),
  initialValue: valueSchema.default(""),
  instance: z.literal("Figma").default("Figma"),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "express",
  tags: ["action", "external"],
  label: "Design variable",
  description:
    "Link a Figma variable or Penpot design token to your flow: drive hardware from your design, or your design from hardware",
  icon: "SwatchBook",
};
