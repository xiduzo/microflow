import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";
import { DEFAULT_MIDI_SONG } from "./midi.constants";

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

// MIDI song note: [noteName | null-for-rest, beats, velocity]. Unlike the Piezo
// song, each note carries its own velocity (a buzzer has no dynamics).
const noteSchema = z.tuple([z.string().nullable(), z.number(), z.number()]);
export type Note = z.infer<typeof noteSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Midi").default("Midi"),
  direction: z.enum(["in", "out"]).default("in"),
  deviceName: z.string().default(""),
  channel: z.number().min(0).max(16).default(0),
  mode: z.enum(["note", "cc", "song"]).default("note"),
  control: z.number().min(0).max(127).default(1),
  note: z.number().min(0).max(127).default(60),
  velocity: z.number().min(0).max(127).default(127),
  // Out + song mode only. Defaulted so a fresh song node plays immediately.
  song: z.array(noteSchema).default(DEFAULT_MIDI_SONG),
  tempo: z.number().min(40).max(240).default(113),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "sense",
  tags: ["value", "source", "action", "external"],
  label: "MIDI",
  description:
    "Receive notes and knob values from MIDI controllers, or play notes and send control changes to synths",
  icon: "KeyboardMusicIcon",
};
