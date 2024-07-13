import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  Switch,
} from "@fhb/ui";
import { Position, useReactFlow } from "@xyflow/react";
import { LedOption } from "johnny-five";
import { useShallow } from "zustand/react/shallow";
import { nodeSelector, useNodesEdgesStore } from "../../../store";
import { Handle } from "./Handle";
import { AnimatedNode, NodeContainer, NodeContent, NodeHeader } from "./Node";

export function Led(props: Props) {
  const { node } = useNodesEdgesStore(
    useShallow(nodeSelector<Props["data"]>(props.id)),
  );
  const { updateNodeData } = useReactFlow();

  if (!node) return null;

  function handleValueChange(pin: string) {
    updateNodeData(props.id, { pin: parseInt(pin) });
  }

  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader>
          <Switch
            className="scale-150"
            disabled
            checked={node.data.value === true}
          />
        </NodeHeader>
        <Select
          value={node.data.pin.toString()}
          onValueChange={handleValueChange}
        >
          <SelectTrigger>Pin {node.data.pin}</SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Set led pin</SelectLabel>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((pin) => (
                <SelectItem key={pin} value={pin.toString()}>
                  {pin}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </NodeContent>
      <Handle index={-1} type="target" position={Position.Top} id="on" />
      <Handle type="target" position={Position.Top} id="toggle" />
      <Handle index={1} type="target" position={Position.Top} id="off" />
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

export type LedData = Omit<LedOption, "board">;
type Props = AnimatedNode<LedData, boolean>;
