import { z } from "zod";
import { baseDataSchema, rgbaSchema } from "../_base/_base.schema";

export const valueSchema = z.union([z.string(), z.number(), z.boolean(), rgbaSchema]);
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  brokerId: z.string().default(""),
  uniqueId: z.string().default(""),
  variableId: z.string().default(""),
  resolvedType: z.enum(["FLOAT", "STRING", "BOOLEAN", "COLOR"]).default("STRING"),
  initialValue: valueSchema.default(""),
  debounceTime: z.number().default(100),
  instance: z.literal("Figma").default("Figma")
});

export type Data = z.infer<typeof dataSchema>;
