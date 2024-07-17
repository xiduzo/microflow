import {
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  cva,
  VariantProps,
} from "@fhb/ui";
import { Node } from "@xyflow/react";
import {
  createContext,
  PropsWithChildren,
  ReactElement,
  useContext,
} from "react";

export function NodeContainer(props: Props) {
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

export function NodeHeader(props: NodeHeaderProps) {
  const { data, id, type } = useNode();

  return (
    <section
      className={cn(
        nodeHeader({
          className: props.className,
          active: props.active || !!data.animated,
        }),
      )}
    >
      {props.children}
    </section>
  );
}

export function NodeContent(props: PropsWithChildren) {
  return (
    <section className="flex flex-col space-y-4 m-2">{props.children}</section>
  );
}

type NodeHeaderProps = PropsWithChildren &
  VariantProps<typeof nodeHeader> & { className?: string };

const nodeHeader = cva(
  "flex p-12 justify-center items-center h-11 rounded-md transition-all dutation-75 min-w-44 pointer-events-none",
  {
    variants: {
      active: {
        true: "bg-yellow-700",
        false: "bg-zinc-700",
      },
    },
    defaultVariants: {
      active: false,
    },
  },
);

const NodeContainerContext = createContext<AnimatedNode>({} as AnimatedNode);
export const useNode = () => useContext(NodeContainerContext);

function BaseNode(props: PropsWithChildren & AnimatedNode) {
  return (
    <NodeContainerContext.Provider value={props}>
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
    </NodeContainerContext.Provider>
  );
}

const node = cva(
  "bg-neutral-950/5 outline -outline-offset-2 outline-neutral-500/25 backdrop-blur-sm rounded-md p-4 min-w-60",
  {
    variants: {
      selectable: {
        true: "",
        false: "",
      },
      selected: {
        true: "outline-blue-500",
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
  },
);

export type AnimatedNode<
  DataType extends Record<string, unknown> = {},
  ValueType = undefined,
> = Node<DataType & { animated?: string; value?: ValueType }>;

type Props = PropsWithChildren &
  AnimatedNode<{}, any> & {
    contextMenu?: ReactElement<typeof ContextMenuContent>;
  };
