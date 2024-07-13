import { Position, useReactFlow } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { nodeSelector, useNodesEdgesStore } from "../../../store";
import { Handle } from "./Handle";
import { AnimatedNode, NodeContainer, NodeContent, NodeHeader } from "./Node";

export function Counter(props: Props) {
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
        <NodeHeader className="text-4xl">{node.data.value ?? 0}</NodeHeader>
      </NodeContent>
      <Handle
        index={-0.5}
        type="target"
        position={Position.Top}
        id="increment"
      />
      <Handle
        index={0.5}
        type="target"
        position={Position.Top}
        id="decrement"
      />
      <Handle index={-0.5} type="target" position={Position.Left} id="set" />
      <Handle index={0.5} type="target" position={Position.Left} id="reset" />
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

type CounterData = {};
type Props = AnimatedNode<CounterData, number>;
