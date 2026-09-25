import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Switch").default("Switch"),
  pin: z.union([z.number(), z.string()]).default(2),
  type: z.enum(["NC", "NO"]).default("NC"),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "sense",
  tags: ["trigger", "source"],
  label: "Switch",
  description: "Detect when a toggle switch flips on or off — supports normally open (NO) and normally closed (NC)",
  icon: "ToggleLeftIcon",
};
