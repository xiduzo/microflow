import { useState, type PropsWithChildren } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/popover";
import { NoteSelector } from "./note-selector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/ui/select";
import {
  type NoteShape,
  type SongNote,
  durationLabel,
  selectableDurations,
  withDuration,
  withPitch,
} from "./notes";
import { Button } from "@/ui/button";

/**
 * A popover that edits one note: its pitch, its duration and whatever else
 * its shape carries. `onSelect` hears every change; `action` is the button
 * that closes the edit (add this note, delete it).
 */
export function NoteEditor<N extends SongNote>(props: Props<N>) {
  const [note, setNote] = useState(props.note);
  const { Extra } = props.shape;

  function update(next: N) {
    setNote(next);
    props.onSelect?.(next);
  }

  return (
    <Popover>
      <PopoverTrigger>{props.children}</PopoverTrigger>
      <PopoverContent className="space-y-2">
        <NoteSelector
          value={String(note[0])}
          onSelect={(pitch) => update(withPitch(note, pitch))}
        />
        <Select onValueChange={(value) => update(withDuration(note, Number(value)))}>
          <SelectTrigger>{durationLabel(Number(note[1]))}</SelectTrigger>
          <SelectContent>
            {selectableDurations(note).map((duration) => (
              <SelectItem key={duration} value={duration.toString()}>
                {durationLabel(duration)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {Extra && <Extra note={note} onChange={update} />}
        <Button
          variant={props.action.variant}
          className="w-full"
          onClick={() => props.action.onClick(note)}
        >
          {props.action.label}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

type Props<N extends SongNote> = PropsWithChildren & {
  note: N;
  shape: NoteShape<N>;
  onSelect?: (note: N) => void;
  action: Action<N>;
};

type Action<N> = {
  variant?:
    | "link"
    | "default"
    | "outline"
    | "secondary"
    | "ghost"
    | "destructive"
    | null; // TODO: use buttonProps
  label: string;
  onClick: (note: N) => void;
};
