import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Counter").default("Counter"),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "generate",
  tags: ["value", "source", "stateful"],
  label: "Counter",
  description: "Keep track of a number that can be increased, decreased, set, or reset",
  icon: "Tally5Icon",
};
