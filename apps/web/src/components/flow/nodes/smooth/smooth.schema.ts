import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

const smoothAverageSchema = baseDataSchema.extend({
  instance: z.literal("Smooth").default("Smooth"),
  type: z.literal("smooth").default("smooth"),
  attenuation: z.number().default(0.995),
});

const movingAverageSchema = baseDataSchema.extend({
  instance: z.literal("MovingAverage").default("MovingAverage"),
  type: z.literal("movingAverage").default("movingAverage"),
  windowSize: z.number().default(25),
});

export const dataSchema = z
  .discriminatedUnion("type", [smoothAverageSchema, movingAverageSchema])
  .default(smoothAverageSchema.parse({ type: "smooth" }));

export type SmoothAverage = z.infer<typeof smoothAverageSchema>;
export type MovingAverage = z.infer<typeof movingAverageSchema>;
export type Data = z.infer<typeof dataSchema>;

// Per-variant defaults, parsed once from the schema so node-UI control fallbacks
// don't re-hardcode the literals. This is the single frontend source for these
// values (the Rust runtime/codegen share their own copy via `config::smooth`;
// unifying the two sides is the deferred config-generator work).
export const smoothDefaults = smoothAverageSchema.parse({ type: "smooth" });
export const movingAverageDefaults = movingAverageSchema.parse({ type: "movingAverage" });

export const defaults = {
  ...dataSchema.parse(undefined),
  group: "shape",
  tags: ["value", "stateful"],
  label: "Smooth",
  description: "Reduce noise in sensor readings using a moving average or low-pass smoothing filter",
  icon: "EraserIcon",
};
