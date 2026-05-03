import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";
import { DEFAULT_MATRIX_SHAPE } from "./matrix.constants";

export const valueSchema = z.array(z.string());
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Matrix").default("Matrix"),
  shapes: z.array(z.array(z.string())).default([DEFAULT_MATRIX_SHAPE]),
  dims: z.string().default("8x8"),
  devices: z.number().default(1),
  pins: z
    .object({
      data: z.number(),
      clock: z.number(),
      cs: z.number(),
    })
    .default({
      data: 2,
      clock: 3,
      cs: 4,
    }),
  controller: z.string().default(undefined as unknown as string),
  address: z.number().optional(),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "express",
  tags: ["action"],
  label: "LED Matrix",
  description: "Display patterns, shapes, or text on an LED matrix — like an 8×8 MAX7219 grid",
  icon: "GridIcon",
};
