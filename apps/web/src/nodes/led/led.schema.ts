import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Led").default("Led"),
  pin: z.union([z.number(), z.string()]).default(13),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "express",
  tags: ["action"],
  label: "LED",
  description: "Turn an LED on or off, or dim it by controlling brightness via PWM",
  icon: "LightbulbIcon",
};
