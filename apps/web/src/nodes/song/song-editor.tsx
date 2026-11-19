import { DndBadge } from "./dnd-badge";
import { NoteEditor } from "./note-editor";
import { type NoteShape, type SongNote, durationLabel } from "./notes";
import { added, draftOf, removed, replaced, songOf, swapped } from "./song-draft";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { DragAndDropProvider } from "@/ui/drag-and-drop";
import { MusicSheet } from "./music-sheet";

/**
 * The dialog a node's song is edited in: the song as sheet music, a badge per
 * note to edit, drag into another place or delete, and a slot that adds one.
 * Nothing reaches the node until the song is saved; `onSave` is handed the
 * notes in the shape the node stores them.
 *
 * The editor knows a note's pitch and duration. What else a node's notes
 * carry, and how that is edited and shown, is the node's `shape`.
 */
export function SongEditor<N extends SongNote>(props: Props<N>) {
  const { shape } = props;
  const [draft, setDraft] = useState(() => draftOf(props.song));

  return (
    <Dialog defaultOpen onOpenChange={props.onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit song</DialogTitle>
        </DialogHeader>
        <section className="flex flex-col space-y-4">
          <MusicSheet
            song={draft.map(({ note }) => [note[0], note[1]])}
            title={props.title}
          />
          <DragAndDropProvider swap={(id, hoveredId) => setDraft((prev) => swapped(prev, id, hoveredId))}>
            <section className="grid gap-2 grid-cols-4">
              {draft.map(({ note, id }) => (
                <NoteEditor
                  key={id}
                  note={note}
                  shape={shape}
                  onSelect={(value) => setDraft((prev) => replaced(prev, id, value))}
                  action={{
                    label: "Delete note",
                    variant: "destructive",
                    onClick: () => setDraft((prev) => removed(prev, id)),
                  }}
                >
                  <DndBadge id={id}>
                    <span>{note[0] ?? "Rest"}</span>
                    <span className="text-muted-foreground">
                      {durationLabel(note[1])}
                      {shape.detail?.(note)}
                    </span>
                  </DndBadge>
                </NoteEditor>
              ))}
              <NoteEditor
                note={shape.blank}
                shape={shape}
                action={{
                  label: "Add note",
                  onClick: (note) => setDraft((prev) => added(prev, note)),
                }}
              >
                <Badge
                  variant="outline"
                  className="text-muted-foreground hover:text-foreground border-dashed hover:cursor-pointer hover:border-solid justify-center w-full h-full"
                >
                  Add note
                </Badge>
              </NoteEditor>
            </section>
          </DragAndDropProvider>
          <DialogFooter>
            <Button variant="destructive" onClick={() => setDraft([])}>
              Clear song
            </Button>
            <DialogClose>
              <Button onClick={() => props.onSave({ song: songOf(draft) })}>
                Save song
              </Button>
            </DialogClose>
          </DialogFooter>
        </section>
      </DialogContent>
    </Dialog>
  );
}

type Props<N extends SongNote> = {
  song: N[];
  title: string;
  shape: NoteShape<N>;
  onSave: (data: { song: N[] }) => void;
  onClose: () => void;
};
