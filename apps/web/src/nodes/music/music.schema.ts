import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

/**
 * How big one audio file may be. Files are inlined as base64 data URLs, so they
 * travel inside the flow document: the collab server caps a Yjs message at 8 MB,
 * and base64 costs ~33% on top of the file.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** …and how much all records together may weigh, for the same reason. */
export const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
/** How many records get their own handle on the canvas before it turns into a
 *  wall of dots. Beyond this, drive the extra ones through `set`. */
export const MAX_HANDLES = 8;

const trackSchema = z.object({
  /** Unique per node: it is the record's dynamic **Port** id on the canvas and
   *  the name `set` matches against. */
  name: z.string(),
  /** The audio file itself, as a `data:` URL. Never sent to the runtime — the
   *  host resolves it by index when the runtime asks to play (ADR-0009). */
  src: z.string(),
});

export type Track = z.infer<typeof trackSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Music").default("Music"),
  tracks: z.array(trackSchema).default([]),
  /** The selected record, as an index into `tracks`. */
  track: z.number().int().min(0).default(0),
  volume: z.number().min(0).max(1).default(0.8),
  loop: z.boolean().default(false),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "express",
  tags: ["action"],
  label: "Music",
  description:
    "Play songs from your computer through its speakers — like the piezo, but for real audio files",
  icon: "Music4Icon",
};
