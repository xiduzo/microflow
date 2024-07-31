import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  Switch,
} from "@fhb/ui";
import { Position } from "@xyflow/react";
import { LedOption } from "johnny-five";
import { MODES } from "../../../../common/types";
import { useUpdateNodeData } from "../../../hooks/nodeUpdater";
import { useBoard } from "../../../providers/BoardProvider";
import { Handle } from "./Handle";
import { BaseNode, NodeContainer, NodeContent, NodeHeader, NodeSettings } from "./Node";

export function Led(props: Props) {
  const { updateNodeData } = useUpdateNodeData<LedData>(props.id);

  const { checkResult } = useBoard();

  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader>
          <Switch
            className="scale-150"
            disabled
            checked={Boolean(props.data.value)}
          />
        </NodeHeader>
        <NodeSettings>
          <Select
            value={props.data.pin.toString()}
            onValueChange={value => {
              updateNodeData({ pin: parseInt(value) });
            }}
          >
            <SelectTrigger>Pin {props.data.pin}</SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Set led pin</SelectLabel>
                {checkResult.pins
                  ?.filter((pin) => pin.supportedModes.includes(MODES.INPUT))
                  .map((pin) => (
                    <SelectItem key={pin.pin} value={pin.pin.toString()}>
                      Pin {pin.pin}
                    </SelectItem>
                  ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </NodeSettings>
      </NodeContent>
      <Handle type="target" position={Position.Top} id="on" offset={-1} />
      <Handle type="target" position={Position.Top} id="toggle" />
      <Handle type="target" position={Position.Top} id="off" offset={1} />
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

export type LedData = Omit<LedOption, "board">;
type Props = BaseNode<LedData, number>;
