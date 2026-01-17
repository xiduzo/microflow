import { type Note } from "./piezo.schema";
import { useState, type PropsWithChildren } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { NoteSelector } from "./note-selector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { noteDurationToVisualDuation } from "./helpers";
import { NOTE_DURATION } from "./piezo.constants";
import { Button } from "@/components/ui/button";

export function NodeEditor(props: Props) {
  const [internalNode, setInternalNode] = useState(props.note);
  const [note, duration] = internalNode;

  return (
    <Popover>
      <PopoverTrigger>{props.children}</PopoverTrigger>
      <PopoverContent className="space-y-2">
        <NoteSelector
          value={String(note)}
          onSelect={(value) => {
            setInternalNode([value, duration]);
            props.onSelect?.([value, duration]);
          }}
        />
        <Select
          onValueChange={(value) => {
            setInternalNode([note, Number(value)]);
            props.onSelect?.([note, Number(value)]);
          }}
        >
          <SelectTrigger>
            {noteDurationToVisualDuation(Number(duration))}
          </SelectTrigger>
          <SelectContent>
            {Object.values(NOTE_DURATION)
              .filter((duration) => {
                if (note === null && duration > 1) return false;
                return duration;
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
        <Button
          variant={props.action.variant}
          className="w-full"
          onClick={() => props.action.onClick(internalNode)}
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
    | null; // TODO: use buttonProps
  label: string;
  onClick: (note: Note) => void;
};
