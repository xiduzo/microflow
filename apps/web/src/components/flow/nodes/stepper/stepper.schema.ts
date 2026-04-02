import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Stepper").default("Stepper"),
  interface: z.enum(["driver", "four_wire"]).default("driver"),
  // Driver mode pins (step/dir)
  stepPin: z.union([z.number(), z.string()]).default(2),
  dirPin: z.union([z.number(), z.string()]).default(3),
  // Four-wire mode pins (IN1–IN4)
  motorPin1: z.union([z.number(), z.string()]).default(4),
  motorPin2: z.union([z.number(), z.string()]).default(5),
  motorPin3: z.union([z.number(), z.string()]).default(6),
  motorPin4: z.union([z.number(), z.string()]).default(7),
  stepsPerRev: z.number().min(1).default(200),
  speed: z.number().min(1).default(200),
  acceleration: z.number().min(0).default(100),
  deviceNum: z.number().min(0).max(9).default(0),
});

export type Data = z.infer<typeof dataSchema>;
