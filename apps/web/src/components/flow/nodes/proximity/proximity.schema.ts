import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";
import { PROXIMITY_CONTROLLERS } from "./proximity.constants";

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Proximity").default("Proximity"),
  pin: z.union([z.number(), z.string()]).default("A0"),
  controller: z.enum(PROXIMITY_CONTROLLERS).default("GP2Y0A21YK"),
  freq: z.number().default(25),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "sense",
  tags: ["value", "source"],
  label: "Proximity",
  description: "Measure the distance to an object using an ultrasonic sensor like the HC-SR04 or SRF04",
  icon: "TargetIcon",
};
