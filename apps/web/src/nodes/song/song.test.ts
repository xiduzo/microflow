// The song editor's logic, for both nodes that have a song: a Piezo note is
// `[pitch, duration]`, a MIDI note `[pitch, duration, velocity]`. The dialog
// itself (`song-editor.tsx`, `note-editor.tsx`) is these functions behind
// buttons; it needs a DOM and is not rendered here.

import { describe, expect, test } from "bun:test";
import { MIDI_NOTE } from "../midi/midi.note";
import { dataSchema as midiSchema, type Note as MidiNote } from "../midi/midi.schema";
import { PIEZO_NOTE } from "../piezo/piezo.note";
import { dataSchema as piezoSchema, type Note as PiezoNote } from "../piezo/piezo.schema";
import {
  DEFAULT_SONG,
  NOTE_DURATION,
  type NoteShape,
  type SongNote,
  durationLabel,
  selectableDurations,
  withDuration,
  withPitch,
} from "./notes";
import { added, draftOf, removed, replaced, songOf, swapped } from "./song-draft";

type Case<N extends SongNote> = {
  shape: NoteShape<N>;
  /** Three notes that differ in every slot, the middle one a rest. */
  song: [N, N, N];
  /** Whether the node's own schema accepts `song` as its stored song. */
  stores: (song: N[]) => boolean;
};

const piezo: Case<PiezoNote> = {
  shape: PIEZO_NOTE,
  song: [
    ["A4", NOTE_DURATION.Quarter],
    [null, NOTE_DURATION.Half],
    ["C#5", NOTE_DURATION.Whole],
  ],
  stores: (song) => piezoSchema.safeParse({ type: "song", song }).success,
};

const midi: Case<MidiNote> = {
  shape: MIDI_NOTE,
  song: [
    ["A4", NOTE_DURATION.Quarter, 100],
    [null, NOTE_DURATION.Half, 64],
    ["C#5", NOTE_DURATION.Whole, 127],
  ],
  stores: (song) => midiSchema.safeParse({ mode: "song", song }).success,
};

function editing<N extends SongNote>(name: string, { shape, song, stores }: Case<N>) {
  const [first, second, third] = song;
  const slots = first.length;

  describe(`editing a ${name} song`, () => {
    test("an untouched draft saves the song it was opened with", () => {
      expect(songOf(draftOf(song))).toEqual(song);
    });

    test("every note of a draft has its own id", () => {
      const ids = draftOf(song).map(({ id }) => id);
      expect(new Set(ids).size).toBe(song.length);
    });

    test("adding the blank note appends it, in the node's note shape", () => {
      const draft = added(draftOf(song), shape.blank);

      expect(songOf(draft)).toEqual([...song, shape.blank]);
      expect(shape.blank).toHaveLength(slots);
      expect(stores(songOf(draft))).toBe(true);
    });

    test("a note that is added gets an id none of the others has", () => {
      const draft = added(added(draftOf(song), shape.blank), shape.blank);
      expect(new Set(draft.map(({ id }) => id)).size).toBe(song.length + 2);
    });

    test("removing a note leaves the others in order", () => {
      const draft = draftOf(song);
      expect(songOf(removed(draft, draft[1]!.id))).toEqual([first, third]);
    });

    test("removing one of two equal notes removes only that one", () => {
      const draft = draftOf([first, first, third]);
      const after = removed(draft, draft[0]!.id);

      expect(songOf(after)).toEqual([first, third]);
      expect(after.map(({ id }) => id)).toEqual([draft[1]!.id, draft[2]!.id]);
    });

    test("removing every note leaves an empty song the node can store", () => {
      const draft = draftOf(song);
      const empty = draft.reduce((left, { id }) => removed(left, id), draft);

      expect(songOf(empty)).toEqual([]);
      expect(stores(songOf(empty))).toBe(true);
    });

    test("swapping two notes exchanges their places and nothing else", () => {
      const draft = draftOf(song);
      const after = swapped(draft, draft[0]!.id, draft[2]!.id);

      expect(songOf(after)).toEqual([third, second, first]);
      // A note keeps its id through a reorder.
      expect(after.map(({ id }) => id)).toEqual([draft[2]!.id, draft[1]!.id, draft[0]!.id]);
    });

    test("swapping with a note that is not in the draft changes nothing", () => {
      const draft = draftOf(song);
      expect(swapped(draft, draft[0]!.id, "gone")).toBe(draft);
      expect(swapped(draft, "gone", draft[0]!.id)).toBe(draft);
    });

    test("replacing a note keeps its place and its id", () => {
      const draft = draftOf(song);
      const after = replaced(draft, draft[1]!.id, third);

      expect(songOf(after)).toEqual([first, third, third]);
      expect(after.map(({ id }) => id)).toEqual(draft.map(({ id }) => id));
    });

    test("an edit returns a new draft and leaves the one it was made on alone", () => {
      const draft = draftOf(song);
      added(draft, shape.blank);
      removed(draft, draft[0]!.id);
      replaced(draft, draft[0]!.id, third);
      swapped(draft, draft[0]!.id, draft[1]!.id);

      expect(songOf(draft)).toEqual(song);
    });

    test("another pitch changes the pitch and no other slot", () => {
      expect(withPitch(first, "D5")).toEqual(["D5", ...first.slice(1)]);
      expect(withPitch(first, "D5")).toHaveLength(slots);
    });

    test("a note becomes a rest, and a rest a note, with its other slots kept", () => {
      expect(withPitch(first, null)).toEqual([null, ...first.slice(1)]);
      expect(withPitch(second, "E5")).toEqual(["E5", ...second.slice(1)]);
    });

    test("another duration changes the duration and no other slot", () => {
      const longer = withDuration(first, NOTE_DURATION.Whole);

      expect(longer).toEqual([first[0], NOTE_DURATION.Whole, ...first.slice(2)]);
      expect(longer).toHaveLength(slots);
    });

    test("a song of edited notes is one the node can store", () => {
      const draft = draftOf(song);
      const edited = replaced(
        replaced(draft, draft[0]!.id, withPitch(first, null)),
        draft[2]!.id,
        withDuration(third, NOTE_DURATION.Sixteenth),
      );

      expect(stores(songOf(edited))).toBe(true);
      expect(songOf(edited).every((note) => note.length === slots)).toBe(true);
    });
  });
}

editing("Piezo", piezo);
editing("MIDI", midi);

describe("the note shapes", () => {
  test("a Piezo note is two slots, a MIDI note three", () => {
    expect(PIEZO_NOTE.blank).toEqual(["C4", NOTE_DURATION.Quarter]);
    expect(MIDI_NOTE.blank).toEqual(["C4", NOTE_DURATION.Quarter, 100]);
  });

  test("a note of the other node's shape is not one a node can store", () => {
    expect(piezo.stores(midi.song as unknown as PiezoNote[])).toBe(false);
    expect(midi.stores(piezo.song as unknown as MidiNote[])).toBe(false);
  });

  test("a Piezo badge says nothing beyond pitch and duration", () => {
    expect(PIEZO_NOTE.detail).toBeUndefined();
    expect(PIEZO_NOTE.Extra).toBeUndefined();
  });

  test("a MIDI badge says the velocity of a note, and not of a rest", () => {
    expect(MIDI_NOTE.detail?.(["A4", NOTE_DURATION.Quarter, 64])).toBe(" · v64");
    expect(MIDI_NOTE.detail?.([null, NOTE_DURATION.Quarter, 64])).toBe("");
  });
});

describe("durations", () => {
  test("a note may last any of the durations", () => {
    expect(selectableDurations(["A4", NOTE_DURATION.Quarter])).toEqual([2, 1, 1 / 2, 1 / 4, 1 / 8, 1 / 16]);
  });

  test("a rest lasts a whole note at most", () => {
    expect(selectableDurations([null, NOTE_DURATION.Quarter, 100])).toEqual([1, 1 / 2, 1 / 4, 1 / 8, 1 / 16]);
  });

  test("are labelled as fractions of a whole note", () => {
    expect(Object.values(NOTE_DURATION).map(durationLabel)).toEqual(["2", "1", "1/2", "1/4", "1/8", "1/16"]);
  });

  test("have no label when they are none of the durations", () => {
    expect(durationLabel(0.3)).toBeUndefined();
  });
});

describe("the demo melody", () => {
  test("is a song both nodes can store, each in its own note shape", () => {
    expect(piezo.stores(DEFAULT_SONG)).toBe(true);
    expect(midiSchema.parse({}).song).toEqual(DEFAULT_SONG.map(([pitch, duration]) => [pitch, duration, 100]));
  });
});
