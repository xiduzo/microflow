import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Note").default("Note"),
  note: z.string().default("New note"),
  extraInfo: z.string().default(""),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "express",
  tags: ["action"],
  label: "Note",
  description: "Add text notes to your flow to document what different parts do",
  icon: "NotebookIcon",
};
