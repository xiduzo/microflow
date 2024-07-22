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
import { useShallow } from "zustand/react/shallow";
import { MODES } from "../../../../common/types";
import { useUpdateNodeData } from "../../../hooks/nodeUpdater";
import { useBoard } from "../../../providers/BoardProvider";
import { nodeSelector, useNodesEdgesStore } from "../../../store";
import { Handle } from "./Handle";
import { AnimatedNode, NodeContainer, NodeContent, NodeHeader } from "./Node";

export function Led(props: Props) {
  const { node } = useNodesEdgesStore(
    useShallow(nodeSelector<Props["data"]>(props.id)),
  );

  const { updateNodeData } = useUpdateNodeData<LedData>(props.id);

  const { checkResult } = useBoard();

  if (!node) return null;

  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader>
          <Switch
            className="scale-150"
            disabled
            checked={Boolean(node.data.value)}
          />
        </NodeHeader>
        <Select
          value={node.data.pin.toString()}
          onValueChange={value => {
            updateNodeData({ pin: parseInt(value) });
          }}
        >
          <SelectTrigger>Pin {node.data.pin}</SelectTrigger>
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
      </NodeContent>
      <Handle type="target" position={Position.Top} id="on" offset={-1} />
      <Handle type="target" position={Position.Top} id="toggle" />
      <Handle type="target" position={Position.Top} id="off" offset={1} />
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

export type LedData = Omit<LedOption, "board">;
type Props = AnimatedNode<LedData, number>;
