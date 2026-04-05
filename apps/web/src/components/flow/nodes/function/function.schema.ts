import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.unknown();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Function").default("Function"),
  code: z.string().default("// Transform the input value and return the result\n// Use {{varName}} to reference connected handle values\nconst value = input;\nreturn value;"),
});

export type Data = z.infer<typeof dataSchema>;
