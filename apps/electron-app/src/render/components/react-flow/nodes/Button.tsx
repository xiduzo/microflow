import {
    Checkbox,
    Icons,
    Label,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Slider,
    Toggle
} from "@fhb/ui";
import { Position } from "@xyflow/react";
import { ButtonOption } from "johnny-five";
import { MODES } from "../../../../common/types";
import { useUpdateNodeData } from "../../../hooks/nodeUpdater";
import { useBoard } from "../../../providers/BoardProvider";
import { Handle } from "./Handle";
import { BaseNode, NodeContainer, NodeContent, NodeHeader, NodeSettings } from "./Node";

export function Button(props: Props) {
  const { pins } = useBoard();

  const { updateNodeData } = useUpdateNodeData<ButtonData>(props.id);

  return (
    <NodeContainer
      {...props}>
      <NodeContent>
        <NodeHeader>
          <Toggle disabled className="opacity-100 disabled:opacity-100" size='lg' pressed={props.data.value}>
            {Boolean(props.data.value) && <Icons.Pointer />}
            {!Boolean(props.data.value) && <Icons.PointerOff />}
          </Toggle>
        </NodeHeader>
      </NodeContent>
      <NodeSettings>
        <Select
          value={props.data.pin.toString()}
          onValueChange={(value) => updateNodeData({ pin: parseInt(value) })}
        >
          <SelectTrigger>Pin {props.data.pin}</SelectTrigger>
          <SelectContent>
            {pins.filter((pin) => pin.supportedModes.includes(MODES.INPUT))
              .map((pin) => (
                <SelectItem key={pin.pin} value={pin.pin.toString()}>
                  Pin {pin.pin}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Label
          htmlFor={`holdtime-${props.id}`}
          className="flex justify-between"
        >
          Hold time
          <span className="opacity-40 font-light">
            {props.data.holdtime ?? 500} ms
          </span>
        </Label>
        <Slider
          id={`holdtime-${props.id}`}
          className="pb-2"
          defaultValue={[props.data.holdtime ?? 500]}
          min={500}
          max={2500}
          step={50}
          onValueChange={(value) =>
            updateNodeData({ holdtime: value[0] })
          }
        />
        <hr />
        <section className="flex justify-between items-start">
          <div className="flex items-center space-x-2"
            onClick={() => updateNodeData({ invert: !props.data.invert })}
          >
            <Checkbox id="inverted" checked={props.data.invert} onChange={console.log} />
            <span
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Invert button
            </span>
          </div>
          <RadioGroup defaultValue="default" onValueChange={value => {
            switch (value) {
              case "default":
                updateNodeData({ isPullup: false, isPulldown: false });
                break;
              case "pullup":
                updateNodeData({ isPullup: true, isPulldown: false });
                break;
              case "pulldown":
                updateNodeData({ isPullup: false, isPulldown: true });
                break;
            }
          }}>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="default" id="default" />
              <Label htmlFor="default">Normal button</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="pullup" id="pullup" />
              <Label htmlFor="pullup">Pullup button</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="pulldown" id="pulldown" />
              <Label htmlFor="pulldown">Pulldown button</Label>
            </div>
          </RadioGroup>
        </section>
      </NodeSettings>
      <Handle type="source" position={Position.Right} id="down" offset={-1} />
      <Handle type="source" position={Position.Right} id="hold" />
      <Handle type="source" position={Position.Right} id="up" offset={1} />
      <Handle type="source" position={Position.Bottom} id="change" />
    </NodeContainer>
  );
}

export type ButtonData = Omit<ButtonOption, "board">;
type Props = BaseNode<ButtonData, boolean>;
