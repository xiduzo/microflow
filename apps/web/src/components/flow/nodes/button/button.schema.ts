import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.union([z.boolean(), z.number()]);
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Button").default("Button"),
  pin: z.union([z.number(), z.string()]).default(6),
  isPullup: z.boolean().default(false),
  isPulldown: z.boolean().default(false),
  holdtime: z.number().default(500),
  invert: z.boolean().default(false),
});
export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "sense",
  tags: ["trigger", "source"],
  label: "Button",
  description: "Detect when a physical button is pressed or released",
  icon: "PointerIcon",
};
