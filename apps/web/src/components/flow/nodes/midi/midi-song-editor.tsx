import { type Note } from "./midi.schema";
import { DndBadge } from "../piezo/dnd-badge";
import { noteDurationToVisualDuation } from "../piezo/helpers";
import { MidiNoteEditor } from "./midi-note-editor";
import { MusicSheet } from "../piezo/music-sheet";
import { DEFAULT_NOTE, DEFAULT_NOTE_DURATION } from "../piezo/piezo.constants";
import { DEFAULT_NOTE_VELOCITY } from "./midi.constants";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DragAndDropProvider } from "@/providers/drag-and-drop";
import { uid } from "@/lib/uid";

// Piezo's SongEditor, forked for MIDI's 3-slot note (per-note velocity). The
// music sheet only renders pitch/duration, so notes map down to 2-tuples there.
export function MidiSongEditor(props: Props) {
  const [editedSong, setEditedSong] = useState(
    props.song.map((note) => ({ note, id: uid() })),
  );

  function swapNotes(id: string, hoveredId: string) {
    setEditedSong((prev) => {
      const leftIndex = prev.findIndex((item) => item.id === id);
      const rightIndex = prev.findIndex((item) => item.id === hoveredId);
      const newSong = [...prev];
      newSong[leftIndex] = prev[rightIndex];
      newSong[rightIndex] = prev[leftIndex];
      return newSong;
    });
  }

  return (
    <Dialog defaultOpen onOpenChange={props.onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit song</DialogTitle>
        </DialogHeader>
        <section className="flex flex-col space-y-4">
          <MusicSheet
            song={editedSong.map(({ note }) => [note[0], note[1]])}
            title={props.title}
          />
          <DragAndDropProvider swap={swapNotes}>
            <section className="grid gap-2 grid-cols-4">
              {editedSong?.map(({ note, id }, index) => (
                <MidiNoteEditor
                  key={id}
                  note={note}
                  onSelect={(value) => {
                    setEditedSong((prev) => {
                      const newSong = [...prev];
                      newSong[index] = { ...newSong[index], note: value };
                      return newSong;
                    });
                  }}
                  action={{
                    label: "Delete note",
                    variant: "destructive",
                    onClick: () => {
                      setEditedSong((prev) => {
                        const newSong = [...prev];
                        newSong.splice(index, 1);
                        return newSong;
                      });
                    },
                  }}
                >
                  <DndBadge id={id}>
                    <span>{note[0] ?? "Rest"}</span>
                    <span className="text-muted-foreground">
                      {noteDurationToVisualDuation(note[1])}
                      {note[0] !== null && ` · v${note[2]}`}
                    </span>
                  </DndBadge>
                </MidiNoteEditor>
              ))}
              <MidiNoteEditor
                note={[DEFAULT_NOTE, DEFAULT_NOTE_DURATION, DEFAULT_NOTE_VELOCITY]}
                action={{
                  label: "Add note",
                  onClick: (note) => {
                    setEditedSong((prev) => [...prev, { note, id: uid() }]);
                  },
                }}
              >
                <Badge
                  variant="outline"
                  className="text-muted-foreground hover:text-foreground border-dashed hover:cursor-pointer hover:border-solid justify-center w-full h-full"
                >
                  Add note
                </Badge>
              </MidiNoteEditor>
            </section>
          </DragAndDropProvider>
          <DialogFooter>
            <Button variant="destructive" onClick={() => setEditedSong([])}>
              Clear song
            </Button>
            <DialogClose>
              <Button
                onClick={() => {
                  props.onSave({ song: editedSong.map(({ note }) => note) });
                }}
              >
                Save song
              </Button>
            </DialogClose>
          </DialogFooter>
        </section>
      </DialogContent>
    </Dialog>
  );
}

type Props = {
  song: Note[];
  title: string;
  onSave: (data: { song: Note[] }) => void;
  onClose: () => void;
};
