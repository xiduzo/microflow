import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";
import { type Controller, MOTION_CONTROLLERS } from "./motion.constants";

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Motion").default("Motion"),
  controller: z.enum(MOTION_CONTROLLERS).default("HCSR501"),
  pin: z.union([z.number(), z.string()]).default("8"),
});

export type Data = z.infer<typeof dataSchema>;
export type { Controller };

export const defaults = {
  ...dataSchema.parse({}),
  group: "sense",
  tags: ["trigger", "source"],
  label: "Motion",
  description: "Detect movement using a PIR sensor (HC-SR501) — like someone walking into a room",
  icon: "EyeIcon",
};
