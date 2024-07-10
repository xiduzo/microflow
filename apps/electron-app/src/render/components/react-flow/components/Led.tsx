import { Position } from "@xyflow/react";
import { Handle } from "./Handle";
import { Node } from "./Node";

export function Led() {
  return (
    <Node>
      <Handle
        type="target"
        position={Position.Top}
        id="on"
        style={{ marginLeft: -25 }}
      />
      <Handle type="target" position={Position.Top} id="toggle" />
      <Handle
        type="target"
        position={Position.Top}
        id="off"
        style={{ marginLeft: 25 }}
      />
      <section>led node</section>
    </Node>
  );
}
