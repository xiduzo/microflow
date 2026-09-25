import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.string();
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

export const defaults = {
  ...dataSchema.parse({}),
  group: "express",
  tags: ["action", "external", "stateful"],
  label: "LLM",
  description: "Use AI to generate text responses based on what you ask it",
  icon: "BotMessageSquareIcon",
};
