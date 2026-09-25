import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Delay").default("Delay"),
  delay: z.number().default(1000),
  forgetPrevious: z.boolean().default(false),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "decide",
  tags: ["trigger", "time-based", "stateful"],
  label: "Delay",
  description: "Hold a signal for a set duration before passing it forward — also supports debounce",
  icon: "SnailIcon",
};
