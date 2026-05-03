import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Calculate").default("Calculate"),
  function: z
    .enum([
      "add",
      "subtract",
      "multiply",
      "divide",
      "modulo",
      "max",
      "min",
      "pow",
      "ceil",
      "floor",
      "round",
    ])
    .default("add"),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "shape",
  tags: ["value"],
  label: "Calculate",
  description: "Perform math operations like adding, subtracting, multiplying, or dividing numbers",
  icon: "CalculatorIcon",
};
