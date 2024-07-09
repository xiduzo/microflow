import { ContextMenuContent, ContextMenuItem } from "@ui/index";
import { Handle, Position } from "@xyflow/react";
import { useCallback } from "react";
import { Node } from "./Node";

export function Button({ data }: Props) {
  const onChange = useCallback((evt: React.ChangeEvent<HTMLInputElement>) => {
    console.log(evt.target.value);
  }, []);

  return (
    <Node
      contextMenu={
        <ContextMenuContent>
          <ContextMenuItem>foo</ContextMenuItem>
          <ContextMenuItem>bar</ContextMenuItem>
        </ContextMenuContent>
      }
    >
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
      <section>// button node</section>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ marginLeft: 25 }}
        id="click"
      />
      <Handle type="source" position={Position.Bottom} id="hold" />
    </Node>
  );
}

type Props = {
  data: unknown;
};
