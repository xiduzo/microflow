import { DEFAULT_NOTE, DEFAULT_NOTE_DURATION, type NoteShape } from "../song/notes";
import { DEFAULT_NOTE_VELOCITY } from "./midi.constants";
import type { Note } from "./midi.schema";

/** A MIDI song note carries its own velocity in a third slot. A rest has one
 *  too, which nothing plays: it is neither shown nor editable. */
export const MIDI_NOTE: NoteShape<Note> = {
  blank: [DEFAULT_NOTE, DEFAULT_NOTE_DURATION, DEFAULT_NOTE_VELOCITY],
  detail: ([pitch, , velocity]) => (pitch === null ? "" : ` · v${velocity}`),
  Extra: Velocity,
};

function Velocity(props: { note: Note; onChange: (note: Note) => void }) {
  const [pitch, duration, velocity] = props.note;

  return (
    <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>velocity</span>
      <input
        type="range"
        min={0}
        max={127}
        step={1}
        value={velocity}
        disabled={pitch === null}
        onChange={(event) => props.onChange([pitch, duration, Number(event.target.value)])}
        className="flex-1"
      />
      <span className="w-8 text-right tabular-nums">{velocity}</span>
    </label>
  );
}
