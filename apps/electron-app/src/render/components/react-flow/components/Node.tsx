import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@fhb/ui";
import { PropsWithChildren, ReactElement } from "react";

export function Node(props: Props) {
  if (props.contextMenu) {
    return (
      <ContextMenu>
        <ContextMenuTrigger>
          <BaseNode>{props.children}</BaseNode>
        </ContextMenuTrigger>
        {props.contextMenu}
      </ContextMenu>
    );
  }

  return <BaseNode>{props.children}</BaseNode>;
}

function BaseNode(props: PropsWithChildren) {
  return (
    <div className="bg-secondary border border-zinc-700 rounded-md p-2 hover:cursor-grab active:cursor-grabbing has-[.selected]:border-zinc-400">
      {props.children}
    </div>
  );
}

type Props = PropsWithChildren & {
  contextMenu?: ReactElement<typeof ContextMenuContent>;
};
