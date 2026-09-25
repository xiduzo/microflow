import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Trigger").default("Trigger"),
  relative: z.boolean().default(false),
  behaviour: z.enum(["increasing", "decreasing"]).default("decreasing"),
  threshold: z.number().default(5),
  within: z.number().default(250),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "decide",
  tags: ["trigger", "logic", "time-based", "stateful"],
  label: "Trigger",
  description: "Send a signal when a value changes by a certain amount, like detecting a sudden change",
  icon: "TrendingUpIcon",
};
