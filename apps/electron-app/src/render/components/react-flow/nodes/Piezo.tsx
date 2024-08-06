import { Label, Select, SelectContent, SelectItem, SelectTrigger, Slider } from "@fhb/ui";
import { Position } from "@xyflow/react";
import { PiezoOption, PiezoTune } from "johnny-five";
import { BoardCheckResult, MODES } from "../../../../common/types";
import { useUpdateNodeData } from "../../../hooks/nodeUpdater";
import { useBoard } from "../../../providers/BoardProvider";
import { Handle } from "./Handle";
import { BaseNode, NodeContainer, NodeContent, NodeHeader, NodeSettings } from "./Node";

const numberFormat = new Intl.NumberFormat();

function validatePin(pin: BoardCheckResult['pins'][0]) {
  return pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.PWM);
}

export function Piezo(props: Props) {
  const { pins } = useBoard();

  const { updateNodeData } = useUpdateNodeData<PiezoData>(props.id);

  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader className="tabular-nums">
          {numberFormat.format(Math.round(props.data.value ?? 0))}
        </NodeHeader>
      </NodeContent>

      <NodeSettings>
        <Select
          value={props.data.pin.toString()}
          onValueChange={(value) => updateNodeData({ pin: Number(value) })}
        >
          <SelectTrigger>Pin {props.data.pin}</SelectTrigger>
          <SelectContent>
            {pins.filter(validatePin)
              .map((pin) => (
                <SelectItem key={pin.pin} value={pin.pin.toString()}>
                  Pin {pin.pin}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>

        <Select
          value={props.data.type}
          onValueChange={(value: "buzz" | "song") => updateNodeData({ type: value })}
        >
          <SelectTrigger>{props.data.type}</SelectTrigger>
          <SelectContent>
          <SelectItem value="buzz">
            Buzz
          </SelectItem>
          <SelectItem value="Song">
            Song
          </SelectItem>
          </SelectContent>
        </Select>

        {props.data.type === "buzz" && (
          <>
            <Label
              htmlFor={`duration-${props.id}`}
              className="flex justify-between"
            >
              Duration
              <span className="opacity-40 font-light">
                {props.data.duration ?? 500}ms
              </span>
            </Label>
            <Slider
              id={`duration-${props.id}`}
              className="pb-2"
              defaultValue={[props.data.duration ?? 500]}
              min={500}
              max={5000}
              step={100}
              onValueChange={(value) => updateNodeData({ duration: value[0] })}
            />
            <Select
              value={props.data.frequency.toString()}
              onValueChange={(value) => updateNodeData({ frequency: Number(value) })}
            >
              <SelectTrigger>Note {Object.keys(PiezoNotes).find(note => PiezoNotes[note] === props.data.frequency)}</SelectTrigger>
              <SelectContent>
                {Object.entries(PiezoNotes)
                  .map(([note, frequency]) => (
                    <SelectItem key={note} value={frequency.toString()}>
                      Note {note}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </>
        )}
      </NodeSettings>
      {props.data.type === 'buzz' && <Handle type="target" position={Position.Left} id="frequency" title="buzz" offset={-0.5} />}
      {props.data.type === 'song' && <Handle type="target" position={Position.Left} id="play" title="song" offset={-0.5} />}
      <Handle type="target" position={Position.Left} id="stop" offset={0.5} />
    </NodeContainer>
  );
}

type BuzzData = { type: "buzz", duration: number, frequency: number }
type SongData = { type: "song" } & PiezoTune
type BaseData = Omit<PiezoOption, 'type'>;

export const PiezoNotes = {
  "c4": 262,
  "c#4": 277,
  "d4": 294,
  "d#4": 311,
  "e4": 330,
  "f4": 349,
  "f#4": 370,
  "g4": 392,
  "g#4": 415,
  "a4": 440,
  "a#4": 466,
  "b4": 494,
  "c5": 523,
  "c#5": 554,
  "d5": 587,
  "d#5": 622,
  "e5": 659,
  "f5": 698,
  "f#5": 740,
  "g5": 784,
  "g#5": 831,
  "a5": 880,
  "a#5": 932,
  "b5": 988,
  "c6": 1047
};

export type PiezoData = BaseData & (BuzzData | SongData);
type Props = BaseNode<PiezoData, number>;
