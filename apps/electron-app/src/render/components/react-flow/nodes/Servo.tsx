import { Input, Select, SelectContent, SelectItem, SelectTrigger } from "@fhb/ui";
import { Position } from "@xyflow/react";
import { ServoGeneralOption } from "johnny-five";
import { BoardCheckResult, MODES } from "../../../../common/types";
import { useUpdateNodeData } from "../../../hooks/nodeUpdater";
import { useBoard } from "../../../providers/BoardProvider";
import { Handle } from "./Handle";
import { AnimatedNode, NodeContainer, NodeContent, NodeHeader } from "./Node";

function validatePin(pin: BoardCheckResult['pins'][0]) {
  return pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.PWM);
}

export function Servo(props: Props) {
  const { checkResult } = useBoard();

  const { updateNodeData } = useUpdateNodeData<ServoData>(props.id);

  const hasValidPin = !!checkResult.pins?.find((pin) => pin.pin === Number(props.data.pin) && validatePin(pin));

  console.log(props.data)
  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader className="text-4xl tabular-nums">
          {props.data.value ?? 0}
        </NodeHeader>
        {checkResult.type === "ready" && !hasValidPin && (
          <div className="text-red-500 text-sm">Pin is not valid for a servo</div>
        )}
        <Select
          value={props.data.pin.toString()}
          onValueChange={(value) => updateNodeData({ pin: value })}
        >
          <SelectTrigger>Pin {props.data.pin}</SelectTrigger>
          <SelectContent>
            {checkResult.pins
              ?.filter(validatePin)
              .map((pin) => (
                <SelectItem key={pin.pin} value={pin.pin.toString()}>
                  Pin {pin.pin}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <section className="flex space-x-2 justify-between items-center">
          <Input type="number" defaultValue={0} onChange={event => updateNodeData({ range: [Number(event.target.value), props.data.range[1]] })} />
          <span className="text-gray-800">-</span>
          <Input type="number" defaultValue={180} onChange={event => updateNodeData({ range: [props.data.range[0], Number(event.target.value)] })} />

        </section>
      </NodeContent>
      <Handle type="target" position={Position.Top} id="min" offset={-1} />
      <Handle type="target" position={Position.Top} id="to" />
      <Handle type="target" position={Position.Top} id="max" offset={1} />
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

export type ServoData = Omit<ServoGeneralOption, "board">;
type Props = AnimatedNode<ServoData, number>;
