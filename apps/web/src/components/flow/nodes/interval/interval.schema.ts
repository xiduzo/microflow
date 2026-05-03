import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";
import { MIN_INTERVAL_IN_MS } from "./interval.constants";

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Interval").default("Interval"),
  interval: z.number().min(MIN_INTERVAL_IN_MS).default(1000),
  autoStart: z.boolean().default(true),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "generate",
  tags: ["trigger", "source", "time-based"],
  label: "Interval",
  description: "Automatically send a signal at regular time intervals, like a timer",
  icon: "TimerIcon",
};
