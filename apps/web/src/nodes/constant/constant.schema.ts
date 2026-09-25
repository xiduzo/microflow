import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Constant").default("Constant"),
  value: z.number().default(1337),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "generate",
  tags: ["value", "source"],
  label: "Constant",
  description: "Provide a fixed number that stays the same and can be used by other nodes",
  icon: "HashIcon",
};
