import { ContextMenuContent, ContextMenuItem } from "@ui/index";
import { Position } from "@xyflow/react";
import { useCallback } from "react";
import { Handle } from "./Handle";
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
      <section>button node</section>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ marginLeft: 25 }}
        id="up"
      />
      <Handle type="source" position={Position.Bottom} id="hold" />
      <Handle
        type="source"
        position={Position.Bottom}
        id="down"
        style={{ marginLeft: -25 }}
      />
    </Node>
  );
}

type Props = {
  data: unknown;
};
