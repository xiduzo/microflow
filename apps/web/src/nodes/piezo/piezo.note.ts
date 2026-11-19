import { DEFAULT_NOTE, DEFAULT_NOTE_DURATION, type NoteShape } from "../song/notes";
import type { Note } from "./piezo.schema";

/** A Piezo song note is a pitch and a duration, nothing more: a buzzer has no
 *  dynamics. */
export const PIEZO_NOTE: NoteShape<Note> = {
  blank: [DEFAULT_NOTE, DEFAULT_NOTE_DURATION],
};
