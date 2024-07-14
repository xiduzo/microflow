import { Select, SelectContent, SelectItem, SelectTrigger } from "@fhb/ui";
import { Position } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { nodeSelector, useNodesEdgesStore } from "../../../store";
import { Handle } from "./Handle";
import { AnimatedNode, NodeContainer, NodeContent, NodeHeader } from "./Node";

export function Figma(props: Props) {
  const { node } = useNodesEdgesStore(
    useShallow(nodeSelector<Props["data"]>(props.id)),
  );

  if (!node) return null;

  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader className="text-4xl">{node.data.value ?? ""}</NodeHeader>
        <Select>
          <SelectTrigger>Variable</SelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4].map((variable) => (
              <SelectItem key={variable} value={variable.toString()}>
                {variable}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </NodeContent>
      <Handle type="target" position={Position.Top} id="set" />

      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

type FigmaData = {};
type Props = AnimatedNode<FigmaData, string | number | boolean>;
