import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";
import { COMPARE_SUB_VALIDATORS } from "./compare.constants";

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

const booleanDataSchema = baseDataSchema.extend({
  instance: z.literal("Compare").default("Compare"),
  validator: z.literal("boolean").default("boolean"),
  subValidator: z.enum(COMPARE_SUB_VALIDATORS.boolean).default("true"),
});

const textDataSchema = baseDataSchema.extend({
  instance: z.literal("Compare").default("Compare"),
  validator: z.literal("text").default("text"),
  subValidator: z.enum(COMPARE_SUB_VALIDATORS.text).default("equal to"),
  text: z.string().default(""),
});

const oddEvenDataSchema = baseDataSchema.extend({
  instance: z.literal("Compare").default("Compare"),
  validator: z.literal("oddEven").default("oddEven"),
  subValidator: z.enum(COMPARE_SUB_VALIDATORS.oddEven).default("even"),
});

const numberDataSchema = baseDataSchema.extend({
  instance: z.literal("Compare").default("Compare"),
  validator: z.literal("number").default("number"),
  subValidator: z.enum(COMPARE_SUB_VALIDATORS.number).default("equal to"),
  number: z.number().default(0),
});

const rangeDataSchema = baseDataSchema.extend({
  instance: z.literal("Compare").default("Compare"),
  validator: z.literal("range").default("range"),
  subValidator: z.enum(COMPARE_SUB_VALIDATORS.range).default("between"),
  range: z
    .object({
      min: z.number().default(0),
      max: z.number().default(100),
    })
    .default({ min: 0, max: 100 }),
});

export const dataSchema = z
  .discriminatedUnion("validator", [
    booleanDataSchema,
    textDataSchema,
    oddEvenDataSchema,
    numberDataSchema,
    rangeDataSchema,
  ])
  .default(booleanDataSchema.parse({ validator: "boolean" }))
  .catch((error) => {
    console.error(error);
    return booleanDataSchema.parse({ validator: "boolean" });
  });

// Each validator's own setting as the schema defaults it. Picking a validator
// in the settings panel writes the validator and its first option, not this
// setting, so a node may not hold it. These are then what the panel shows,
// what the node says on its face and what it checks: the Rust config's
// defaults (`nodes::compare::config`) are the same values, which the Catalog
// Parity Guard holds.
export const numberDefaults = numberDataSchema.parse({ validator: "number" });
export const rangeDefaults = rangeDataSchema.parse({ validator: "range" });
export const textDefaults = textDataSchema.parse({ validator: "text" });

export type BooleanData =z.infer<typeof booleanDataSchema>;
export type TextData = z.infer<typeof textDataSchema>;
export type NumberData = z.infer<typeof oddEvenDataSchema>;
export type SingleNumberData = z.infer<typeof numberDataSchema>;
export type RangeNumberData = z.infer<typeof rangeDataSchema>;
export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse(undefined),
  group: "decide",
  tags: ["trigger", "logic"],
  label: "Compare",
  description: "Check if a value meets a condition and output true or false",
  icon: "ShieldCheckIcon",
};
