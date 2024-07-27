import { Select, SelectContent, SelectItem, SelectTrigger } from "@fhb/ui";
import { Position } from "@xyflow/react";
import { SensorOption } from "johnny-five";
import { BoardCheckResult, MODES } from "../../../../common/types";
import { useUpdateNodeData } from "../../../hooks/nodeUpdater";
import { useBoard } from "../../../providers/BoardProvider";
import { Handle } from "./Handle";
import { AnimatedNode, NodeContainer, NodeContent, NodeHeader } from "./Node";

function validatePin(pin: BoardCheckResult['pins'][0]) {
  return pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.ANALOG);
}

export function Sensor(props: Props) {
  const { checkResult } = useBoard();

  const { updateNodeData } = useUpdateNodeData<SensorData>(props.id);

  const hasValidPin = !!checkResult.pins?.find((pin) => `A${pin.analogChannel}` === props.data.pin && validatePin(pin));

  return (
    <NodeContainer {...props}>
      <NodeContent>
        {checkResult.type === "ready" && !hasValidPin && (
          <div className="text-red-500 text-sm">Pin is not valid for a {props.type}</div>
        )}
        <NodeHeader className="text-4xl tabular-nums">
          {props.data.value ?? 0}
        </NodeHeader>
        <Select
          value={props.data.pin.toString()}
          onValueChange={(value) => updateNodeData({ pin: value })}
        >
          <SelectTrigger>Pin {props.data.pin}</SelectTrigger>
          <SelectContent>
            {checkResult.pins
              ?.filter(validatePin)
              .map((pin) => (
                <SelectItem key={pin.pin} value={`A${pin.analogChannel}`}>
                  Pin A{pin.analogChannel}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </NodeContent>
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

export type SensorData = Omit<SensorOption, "board">;
type Props = AnimatedNode<SensorData, number>;
