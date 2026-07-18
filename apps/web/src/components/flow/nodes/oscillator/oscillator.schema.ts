import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const waveformTypeSchema = z.enum([
  "sinus",
  "square",
  "sawtooth",
  "triangle",
  "random",
  "randomwalk",
  "perlin",
]);
export type WaveformType = z.infer<typeof waveformTypeSchema>;

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Oscillator").default("Oscillator"),
  waveform: waveformTypeSchema.default("sinus"),
  period: z.number().default(1000),
  amplitude: z.number().default(1),
  phase: z.number().default(0),
  shift: z.number().default(0),
  autoStart: z.boolean().default(true),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "generate",
  tags: ["value", "source", "time-based"],
  label: "Oscillator",
  description: "Generate repeating wave patterns — sine, square, sawtooth, or triangle — to animate or cycle values",
  icon: "AudioWaveformIcon",
};
