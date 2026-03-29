import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.union([z.boolean(), z.string()]);
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Llm").default("Llm"),
  providerId: z.string().default(""),
  provider: z.literal("ollama").default("ollama"),
  model: z.string().default(""),
  prompt: z.string().default(""),
  system: z.string().default(""),
});

export type Data = z.infer<typeof dataSchema>;
