import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Servo").default("Servo"),
  pin: z.union([z.number(), z.string()]).default(3),
  range: z
    .object({
      min: z.number().default(0),
      max: z.number().default(180),
    })
    .default({ min: 0, max: 180 }),
  type: z.enum(["standard", "continuous"]).default("standard"),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "express",
  tags: ["action", "value"],
  label: "Servo",
  description: "Move a servo motor to a specific angle (0–180°) or spin it continuously",
  icon: "RotateCwIcon",
};
