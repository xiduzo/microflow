import { DEFAULT_SONG } from "../song/notes";

/** Mezzo-forte default velocity for freshly-added song notes. */
export const DEFAULT_NOTE_VELOCITY = 100;

/**
 * The demo melody, with every note at the default velocity. MIDI
 * song notes are `[name | null-for-rest, beats, velocity]`.
 */
export const DEFAULT_MIDI_SONG: [string | null, number, number][] =
  DEFAULT_SONG.map(([note, beats]) => [note, beats, DEFAULT_NOTE_VELOCITY]);
