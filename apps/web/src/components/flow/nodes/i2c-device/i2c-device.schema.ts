import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.union([z.number(), z.array(z.number())]);
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("I2cDevice").default("I2cDevice"),
  address: z.number().min(0).max(127).default(0x48),
  register: z.number().min(0).max(255).default(0x00),
  readLength: z.number().min(1).max(32).default(2),
  freq: z.number().min(10).default(100),
  device: z.string().default("custom"),
  output: z.enum(["raw", "unsigned_int", "signed_int"]).default("unsigned_int"),
});

export type Data = z.infer<typeof dataSchema>;
