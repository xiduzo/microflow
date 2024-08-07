import { Button, Icons, Label, Select, SelectContent, SelectItem, SelectTrigger, Slider } from "@fhb/ui";
import { Position } from "@xyflow/react";
import { PiezoOption, PiezoTune } from "johnny-five";
import { BoardCheckResult, MODES } from "../../../../common/types";
import { useUpdateNodeData, useUpdateNodesHandles } from "../../../hooks/nodeUpdater";
import { useBoard } from "../../../providers/BoardProvider";
import { MusicSheet } from "../../Abc";
import { Handle } from "./Handle";
import { BaseNode, NodeContainer, NodeContent, NodeHeader, NodeSettings } from "./Node";

function validatePin(pin: BoardCheckResult['pins'][0]) {
  return pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.PWM);
}

export function Piezo(props: Props) {
  const { pins } = useBoard();
  const { updateNodesHandles } = useUpdateNodesHandles(props.id);
  const { updateNodeData } = useUpdateNodeData<PiezoData>(props.id);

  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader className="tabular-nums">
          {props.data.type === "song" && <Icons.Music />}
          {props.data.type === "buzz" && <Icons.BellElectric />}
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
          onValueChange={(value: "buzz" | "song") => {
            updateNodesHandles();

            let update = { type: value } as BuzzData | SongData
            if (value === 'buzz') {
              update = { ...update, duration: 500, frequency: 2500 } as BuzzData;
            } else {
              update = { ...update, tempo: 100, song: defaultSong } as SongData;
            }
            updateNodeData(update)
          }}
        >
          <SelectTrigger>{props.data.type}</SelectTrigger>
          <SelectContent>
          <SelectItem value="buzz">
            Buzz
          </SelectItem>
          <SelectItem value="song">
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
              defaultValue={[props.data.duration ?? 500]}
              min={500}
              max={5000}
              step={100}
              onValueChange={(value) => updateNodeData({ duration: value[0] })}
            />
            <Label
              htmlFor={`frequency-${props.id}`}
              className="flex justify-between"
            >
              Frequency
              <span className="opacity-40 font-light">
                {props.data.frequency ?? 2500}Hz
              </span>
            </Label>
            <Slider
              id={`frequency-${props.id}`}
              defaultValue={[props.data.frequency ?? 2500]}
              min={31}
              max={4978}
              step={1}
              onValueChange={(value) => updateNodeData({ frequency: value[0] })}
            />
          </>
        )}
        {props.data.type === "song" && (
          <>
            <Label
              htmlFor={`tempo-${props.id}`}
              className="flex justify-between"
            >
              Tempo
              <span className="opacity-40 font-light">
                {props.data.tempo ?? 100}
              </span>
            </Label>
            <Slider
              id={`tempo-${props.id}`}
              defaultValue={[props.data.tempo ?? 100]}
              min={10}
              max={300}
              step={5}
              onValueChange={(value) => updateNodeData({ tempo: value[0] })}
            />
            <MusicSheet song={props.data.song } />
            <Button variant="secondary">
              Edit song
            </Button>
          </>
        )}
      </NodeSettings>
      {props.data.type === 'buzz' && <Handle type="target" position={Position.Left} id="buzz" offset={-0.5} />}
      {props.data.type === 'song' && <Handle type="target" position={Position.Left} id="play" offset={-0.5} />}
      <Handle type="target" position={Position.Left} id="stop" offset={0.5} />
    </NodeContainer>
  );
}

type BuzzData = { type: "buzz", duration: number, frequency: number }
type SongData = { type: "song" } & PiezoTune & { song: [string | null, number][] }
type BaseData = Omit<PiezoOption, 'type'>;

// Based on https://github.com/bhagman/Tone?tab=readme-ov-file#musical-notes
export const Notes = new Map<string, number>([
  ["B0", 31],
  ["C1", 33],
  ["C#1", 35],
  ["D1", 37],
  ["D#1", 39],
  ["E1", 41],
  ["F1", 44],
  ["F#1", 46],
  ["G1", 49],
  ["G#1", 52],
  ["A1", 55],
  ["A#1", 58],
  ["B1", 62],
  ["C2", 65],
  ["C#2", 69],
  ["D2", 73],
  ["D#2", 78],
  ["E2", 82],
  ["F2", 87],
  ["F#2", 93],
  ["G2", 98],
  ["G#2", 104],
  ["A2", 110],
  ["A#2", 117],
  ["B2", 123],
  ["C3", 131],
  ["C#3", 139],
  ["D3", 147],
  ["D#3", 156],
  ["E3", 165],
  ["F3", 175],
  ["F#3", 185],
  ["G3", 196],
  ["G#3", 208],
  ["A3", 220],
  ["A#3", 233],
  ["B3", 247],
  ["C4", 262],
  ["C#4", 277],
  ["D4", 294],
  ["D#4", 311],
  ["E4", 330],
  ["F4", 349],
  ["F#4", 370],
  ["G4", 392],
  ["G#4", 415],
  ["A4", 440],
  ["A#4", 466],
  ["B4", 494],
  ["C5", 523],
  ["C#5", 554],
  ["D5", 587],
  ["D#5", 622],
  ["E5", 659],
  ["F5", 698],
  ["F#5", 740],
  ["G5", 784],
  ["G#5", 831],
  ["A5", 880],
  ["A#5", 932],
  ["B5", 988],
  ["C6", 1047],
  ["C#6", 1109],
  ["D6", 1175],
  ["D#6", 1245],
  ["E6", 1319],
  ["F6", 1397],
  ["F#6", 1480],
  ["G6", 1568],
  ["G#6", 1661],
  ["A6", 1760],
  ["A#6", 1865],
  ["B6", 1976],
  ["C7", 2093],
  ["C#7", 2217],
  ["D7", 2349],
  ["D#7", 2489],
  ["E7", 2637],
  ["F7", 2794],
  ["F#7", 2960],
  ["G7", 3136],
  ["G#7", 3322],
  ["A7", 3520],
  ["A#7", 3729],
  ["B7", 3951],
  ["C8", 4186],
  ["C#8", 4435],
  ["D8", 4699],
  ["D#8", 4978],
])

export const PiezoNoteDuration = {
  DoubleWhole: 2,
  Whole: 1,
  Half: 1/2,
  Quarter: 1/4,
  Eighth: 1/8,
  Sixteenth: 1/16,
}

export const defaultSong: [string | null, number][] = [
  ["C4", PiezoNoteDuration.Quarter],
  ["D4", PiezoNoteDuration.Quarter],
  ["F4", PiezoNoteDuration.Quarter],
  ["D4", PiezoNoteDuration.Quarter],
  ["A4", PiezoNoteDuration.Quarter],
  [null, PiezoNoteDuration.Quarter],
  ["A4", PiezoNoteDuration.Whole],
  ["G4", PiezoNoteDuration.Whole],
  [null, PiezoNoteDuration.Half],
  ["C4", PiezoNoteDuration.Quarter],
  ["D4", PiezoNoteDuration.Quarter],
  ["F4", PiezoNoteDuration.Quarter],
  ["D4", PiezoNoteDuration.Quarter],
  ["G4", PiezoNoteDuration.Quarter],
  [null, PiezoNoteDuration.Quarter],
  ["G4", PiezoNoteDuration.Whole],
  ["F4", PiezoNoteDuration.Whole],
  [null, PiezoNoteDuration.Half],
]

export type PiezoData = BaseData & (BuzzData | SongData);
type Props = BaseNode<PiezoData, number>;
