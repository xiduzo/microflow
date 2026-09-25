import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Relay").default("Relay"),
  pin: z.union([z.number(), z.string()]).default(10),
  type: z.enum(["NO", "NC"]).default("NO"),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "express",
  tags: ["action"],
  label: "Relay",
  description: "Switch high-power devices on or off safely — lights, motors, fans, or household appliances",
  icon: "ZapIcon",
};
