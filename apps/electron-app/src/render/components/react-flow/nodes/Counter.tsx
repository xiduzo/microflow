import { Position } from "@xyflow/react";
import { Handle } from "./Handle";
import { BaseNode, NodeContainer, NodeContent, NodeHeader, NodeSettings } from "./Node";

const numberFormat = new Intl.NumberFormat();

export function Counter(props: Props) {
  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader className="text-4xl tabular-nums">
          {numberFormat.format(props.data.value ?? 0)}
        </NodeHeader>
      </NodeContent>
      <Handle
        offset={-0.5}
        type="target"
        position={Position.Top}
        id="increment"
      />
      <NodeSettings>
      </NodeSettings>
      <Handle
        offset={0.5}
        type="target"
        position={Position.Top}
        id="decrement"
      />
      <Handle type="target" position={Position.Left} id="set" offset={-0.5} />
      <Handle type="target" position={Position.Left} id="reset" offset={0.5} />
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

export type CounterData = {};
type Props = BaseNode<CounterData, number>;
