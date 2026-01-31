import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.unknown();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Monitor").default("Monitor"),
  type: z.enum(["graph", "raw"]).default("graph"),
});

export type Data = z.infer<typeof dataSchema>;
