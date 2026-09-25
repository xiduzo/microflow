import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

// The card UID is emitted as an uppercase, separator-free hex string
// (e.g. "04A2B1C3"); empty until the first card is read.
export const valueSchema = z.string();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Pn532").default("Pn532"),
  // 0x24 (36) when the Aideepen V3 module's DIP switches select I2C (not SPI/HSU).
  address: z.number().min(0).max(255).default(0x24),
  // How often a fresh scan (InListPassiveTarget) is issued while sensing for a
  // card — mirrors the runtime config's `pollIntervalMs`. Floored in practice by
  // the board's global sampling interval when sharing a bus.
  pollIntervalMs: z.number().min(50).max(10000).default(300),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "sense",
  tags: ["nfc", "rfid", "hardware"],
  label: "NFC Reader",
  beta: true,
  description: "Read an NFC/RFID card UID over I2C with a PN532 module",
  icon: "NfcIcon",
};
