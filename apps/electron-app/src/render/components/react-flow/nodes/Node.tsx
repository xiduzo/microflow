import {
  Button,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
  cva,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  VariantProps
} from "@fhb/ui";
import { Node, useReactFlow } from "@xyflow/react";
import {
  createContext,
  PropsWithChildren,
  ReactElement,
  useContext,
  useEffect,
  useRef,
} from "react";

export function NodeSettings(props: NodeContainerProps) {
  const node = useNode();
  const { updateNodeData, deleteElements } = useReactFlow<BaseNode>();

  function closeDrawer() {
    updateNodeData(node.id, { settingsOpen: false })
  }

  return (
    <Drawer open={node.data.settingsOpen} nested onOpenChange={(update) => {
      if (update === true) return
      closeDrawer()
    }}>
      <DrawerContent>
        <DrawerHeader className="max-w-md w-full m-auto mt-6">
          <DrawerTitle className="flex items-center justify-between">
            Edit {node.type} node
            <span className="text-xs font-light text-neutral-500">id: {node.id}</span>
          </DrawerTitle>
          <DrawerDescription>Updates will be automatically applied</DrawerDescription>
        </DrawerHeader>
        <section className="max-w-md w-full m-auto flex flex-col space-y-4 mb-8 p-4">
          {props.children}
        </section>
        <DrawerFooter className="max-w-md w-full m-auto">
          <Button variant="outline" onClick={closeDrawer}>Close</Button>
          <Button variant="destructive" onClick={() => deleteElements({ nodes: [node] })}>Delete node</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}

type NodeContainerProps = PropsWithChildren & {
  className?: string
}

export function NodeContainer(props: Props) {
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <BaseNode {...props}>
          {props.children}
          {props.contextMenu ?? <BaseContextMenu />}
        </BaseNode>
      </ContextMenuTrigger>
    </ContextMenu>
  );
}

export function NodeHeader(props: NodeHeaderProps) {
  const { data, type } = useNode();
  const prevValue = useRef(props.valueOverride ?? data.value);

  useEffect(() => {
    if (data.animated) return

    prevValue.current = props.valueOverride ?? data.value
  }, [data.animated, data.value, props.valueOverride])

  return (
    <section
      className={cn(
        nodeHeader({
          className: props.className,
          active: props.active || (!!data.animated && (props.valueOverride ?? data.value) !== prevValue.current),
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
  VariantProps<typeof nodeHeader> & { className?: string, valueOverride?: unknown };

const nodeHeader = cva(
  "flex p-10 justify-center items-center h-11 rounded-md transition-all dutation-75 min-w-48 pointer-events-none",
  {
    variants: {
      active: {
        true: "bg-yellow-700",
        false: "bg-zinc-700",
      },
      defaultVariants: {
        active: false,
      },
    },
  },
);

const NodeContainerContext = createContext<BaseNode>({} as BaseNode);
export const useNode = () => useContext(NodeContainerContext);

function BaseNode(props: PropsWithChildren & BaseNode) {
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

function BaseContextMenuItems() {
  const node = useNode();
  const { deleteElements, updateNodeData } = useReactFlow<BaseNode>();

  return (
    <>
      <ContextMenuItem onClick={() => updateNodeData(node.id, { settingsOpen: true })}>
        Settings
      </ContextMenuItem>
      <ContextMenuItem className="text-red-500" onClick={() => deleteElements({ nodes: [node] })}>
        Delete
        <ContextMenuShortcut>⌫</ContextMenuShortcut>
      </ContextMenuItem>
    </>
  );
}

function BaseContextMenu() {
  return (
    <ContextMenuContent>
      <BaseContextMenuItems />
    </ContextMenuContent>
  )
}

export type BaseNode<
  DataType extends Record<string, unknown> = {},
  ValueType = undefined,
> = Node<DataType & { animated?: string; value?: ValueType, settingsOpen?: boolean }>;

type Props = PropsWithChildren &
  BaseNode<{}, any> & {
    contextMenu?: ReactElement<typeof ContextMenuContent>;
  };
