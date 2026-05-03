import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Gate").default("Gate"),
  gate: z.enum(["or", "and", "xor", "nor", "nand", "xnor"]).default("and"),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "decide",
  tags: ["trigger", "logic", "stateful"],
  label: "Gate",
  description: "Apply boolean logic (AND, OR, XOR, NAND, NOR, XNOR) to combine signals and control flow",
  icon: "GitPullRequestClosedIcon",
};
