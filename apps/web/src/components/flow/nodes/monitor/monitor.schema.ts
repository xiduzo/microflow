import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.unknown();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Monitor").default("Monitor"),
  type: z.enum(["graph", "raw"]).default("graph"),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "express",
  tags: ["action"],
  label: "Monitor",
  description: "Inspect and graph values flowing through your flow in real-time — great for debugging",
  icon: "MonitorIcon",
};
