import {
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  cva,
} from "@fhb/ui";
import { Node } from "@xyflow/react";
import { PropsWithChildren, ReactElement } from "react";

export function BaseComponent(props: Props) {
  if (props.contextMenu) {
    return (
      <ContextMenu>
        <ContextMenuTrigger>
          <BaseNode {...props} />
        </ContextMenuTrigger>
        {props.contextMenu}
      </ContextMenu>
    );
  }

  return <BaseNode {...props} className="min-w-48" />;
}

function BaseNode(props: PropsWithChildren & Node) {
  return (
    <div
      className={cn(
        node({
          className: props.className,
          deletabled: props.deletable,
          draggable: props.draggable,
          dragging: props.dragging,
          selectable: props.selectable,
          selected: props.selected,
        }),
      )}
    >
      {props.children}
    </div>
  );
}

const node = cva(
  "bg-neutral-950/5 outline -outline-offset-2 outline-neutral-500/25 backdrop-blur-sm rounded-md p-4 transition-all min-w-60",
  {
    variants: {
      selectable: {
        true: "",
        false: "",
      },
      selected: {
        true: "outline-green-500",
        false: "",
      },
      draggable: {
        true: "active:cursor-grabbing",
        false: "",
      },
      dragging: {
        true: "",
        false: "",
      },
      deletabled: {
        true: "",
        false: "",
      },
    },
    defaultVariants: {
      selectable: false,
      selected: false,
      draggable: false,
      dragging: false,
      deletabled: false,
    },
    compoundVariants: [
      {
        selectable: true,
        selected: false,
        className: "hover:outline-green-500/25",
      },
    ],
  },
);

type Props = PropsWithChildren &
  Node & {
    contextMenu?: ReactElement<typeof ContextMenuContent>;
  };
