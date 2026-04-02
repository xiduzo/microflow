import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const VALID_HOTKEYS = [
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  ..."0123456789".split(""),
] as const;

export type HotkeyChar = (typeof VALID_HOTKEYS)[number];

export const hotkeyCharSchema = z
  .string()
  .length(1)
  .refine((v): v is HotkeyChar => VALID_HOTKEYS.includes(v as HotkeyChar));

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Hotkey").default("Hotkey"),
  accelerator: z.string().default("x"),
});
export type Data = z.infer<typeof dataSchema>;
