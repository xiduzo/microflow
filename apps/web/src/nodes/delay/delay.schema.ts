import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Delay").default("Delay"),
  delay: z.number().default(1000),
  // Off: every signal is passed on, each `delay` ms after it arrived (up to 16
  // waiting at once). On: a new signal replaces the waiting one, so only the
  // last is passed on (debounce). The same live and in the exported sketch.
  forgetPrevious: z.boolean().default(false),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "decide",
  tags: ["trigger", "time-based", "stateful"],
  label: "Delay",
  description: "Pass every signal on after a set time — or, with debounce, only the last one",
  icon: "SnailIcon",
};
