import { type Note } from "./midi.schema";
import { useState, type PropsWithChildren } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { NoteSelector } from "../piezo/note-selector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { noteDurationToVisualDuation } from "../piezo/helpers";
import { NOTE_DURATION } from "../piezo/piezo.constants";
import { Button } from "@/components/ui/button";

// Piezo's NodeEditor, forked to carry a per-note velocity (a buzzer has none).
// Reuses Piezo's velocity-agnostic NoteSelector / duration helpers.
export function MidiNoteEditor(props: Props) {
  const [internalNote, setInternalNote] = useState(props.note);
  const [note, duration, velocity] = internalNote;

  function update(next: Note) {
    setInternalNote(next);
    props.onSelect?.(next);
  }

  return (
    <Popover>
      <PopoverTrigger>{props.children}</PopoverTrigger>
      <PopoverContent className="space-y-2">
        <NoteSelector
          value={String(note)}
          onSelect={(value) => update([value, duration, velocity])}
        />
        <Select
          onValueChange={(value) => update([note, Number(value), velocity])}
        >
          <SelectTrigger>
            {noteDurationToVisualDuation(Number(duration))}
          </SelectTrigger>
          <SelectContent>
            {Object.values(NOTE_DURATION)
              .filter((selectableDuration) => {
                if (note === null && selectableDuration > 1) return false;
                return selectableDuration;
              })
              .map((selectableDuration) => (
                <SelectItem
                  key={selectableDuration}
                  value={selectableDuration.toString()}
                >
                  {noteDurationToVisualDuation(selectableDuration)}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>velocity</span>
          <input
            type="range"
            min={0}
            max={127}
            step={1}
            value={velocity}
            disabled={note === null}
            onChange={(event) =>
              update([note, duration, Number(event.target.value)])
            }
            className="flex-1"
          />
          <span className="w-8 text-right tabular-nums">{velocity}</span>
        </label>
        <Button
          variant={props.action.variant}
          className="w-full"
          onClick={() => props.action.onClick(internalNote)}
        >
          {props.action.label}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

type Props = PropsWithChildren & {
  note: Note;
  onSelect?: (note: Note) => void;
  action: Action;
};

type Action = {
  variant?:
    | "link"
    | "default"
    | "outline"
    | "secondary"
    | "ghost"
    | "destructive"
    | null;
  label: string;
  onClick: (note: Note) => void;
};
