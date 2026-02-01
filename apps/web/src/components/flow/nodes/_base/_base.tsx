import { LevaPanel, useControls, useCreateStore } from "leva";
import { type Node, type NodeProps, useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import {
  CardAction,
  CardHeader,
  CardTitle,
  CardDescription,
  Card,
  CardContent,
} from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cva } from "class-variance-authority";
import { OctagonAlertIcon, CableIcon } from "lucide-react";
import { useFlowStore } from "@/stores/flow-store";
import { usePins } from "@/stores/board";
import { Pin } from "@/components/hardware/pin";
import { Icon, type IconName } from "@/components/ui/icon";

function NodeHeader(props: { error?: string }) {
  const data = useNodeData();

  return (
    <CardHeader className="flex items-center gap-2">
      <div className={groupIndicator({ group: data.group })}>
        <Icon icon={data.icon} />
      </div>
      <section className="grow">
        <CardTitle>
          {data.label}
        </CardTitle>
        <NodeDescription />
      </section>
      {props.error && (
        <CardAction>
          <Tooltip>
            <TooltipTrigger className="cursor-help">
              <OctagonAlertIcon className="text-red-500" />
            </TooltipTrigger>
            <TooltipContent className="text-red-500">{props.error}</TooltipContent>
          </Tooltip>
        </CardAction>
      )}
    </CardHeader>
  );
}

const groupIndicator = cva("size-9 rounded-sm flex items-center justify-center", {
  variants: {
    group: {
      sense: "text-sky-900 bg-sky-500/30 dark:text-sky-200 dark:bg-sky-600/30",
      generate: "text-emerald-900 bg-emerald-500/20 dark:text-emerald-200 dark:bg-emerald-400/20",
      shape: "text-cyan-900 bg-cyan-300/50 dark:text-cyan-200 dark:bg-cyan-400/20",
      decide: "text-amber-900 bg-amber-500/20 dark:text-amber-200 dark:bg-amber-400/20",
      express: "text-violet-900 bg-violet-500/20 dark:text-violet-200 dark:bg-violet-400/20",
      internal: "text-slate-900 bg-slate-500/20 dark:text-slate-200 dark:bg-slate-400/20",
    },
  },
});

function NodeDescription() {
  const data = useNodeData();
  const pins = usePins();

  const hasPin = "pin" in data;
  const hasPins = "pins" in data;

  return (
    <CardDescription className="flex gap-4">
      {hasPin && (
        <div className="flex items-center gap-1" key={`pin-${data.pin}`}>
          <CableIcon size={12} />
          <Pin pin={data.pin} pins={pins} />
        </div>
      )}
      {hasPins &&
        Object.entries(data.pins).map(([key, value]) => (
          <div key={key} className="flex items-center gap-1">
            <CableIcon size={12} />
            <span className="font-extralight">
              {key}: {String(value)}
            </span>
          </div>
        ))}
      {!hasPin && !hasPins && (
        <span className="font-extralight">
          {/* empty space to align the card description */}
          &nbsp;
        </span>
      )}
    </CardDescription>
  );
}

type UseControlParameters = Parameters<typeof useControls>;
export type Controls = Exclude<UseControlParameters[0], string | Function>;

export const useNodeControls = <
  Data extends Record<string, any> = Record<string, any>,
  S extends Controls = Controls,
>(
  controls: S,
  dependencies: unknown[] = [],
) => {
  const store = useCreateStore();
  const { selected, id, data } = useNode();
  const isFirstRender = useRef(true);
  const { getNode } = useReactFlow();
  const onNodesChange = useFlowStore((state) => state.onNodesChange);
  const updateNodeInternals = useUpdateNodeInternals();

  const [controlsData, set] = useControls(
    () => ({ label: data.label, ...controls }),
    { store },
    dependencies,
  );
  const lastControlData = useRef(controlsData);

  const updateNodeData = useCallback(
    async (data: Record<string, unknown>) => {
      const node = getNode(id);
      if (!node) return;

      onNodesChange([
        {
          id: node.id,
          type: "replace",
          item: {
            ...node,
            data: { ...node.data, ...(data as Record<string, unknown>) },
          },
        },
      ]);
      updateNodeInternals(node.id);
      // Note: Flow sync is now automatic through FlowDocument observers
    },
    [id, getNode, onNodesChange, updateNodeInternals],
  );

  useEffect(() => {
    updateNodeData(controlsData as Data);
  }, [controlsData]);

  /**
   * Sometimes it is impossible to set the node data using the controls,
   * use this handler to forcefully update the node
   * ⚠️ this might cause descrepencies between the `data` from `useNodeData` and the actual data
   */
  const setNodeData = useCallback(
    <T extends Record<string, unknown>>(node: Partial<Data>) => {
      updateNodeData(node as T);
    },
    [updateNodeData],
  );

  const render = useCallback(() => {
    if (!selected) return null;
    const element = document.getElementById("settings-panels")
    if (!element) return
    return createPortal(
      <LevaPanel store={store} hideCopyButton fill titleBar={false} />,
      element,
    );
  }, [store, selected]);

  /**
   * Sync the data back to the controls when history is reverted
   */
  useEffect(() => {
    if (isFirstRender.current) return;

    // Only compare keys which are in the controls data
    const keys = Object.keys(lastControlData.current as Record<string, unknown>);
    const dataKeys = Object.keys(data);

    // Check if any value has changed
    const hasChanged = keys.some(
      (key) =>
        dataKeys.includes(key) &&
        lastControlData.current[key as keyof typeof lastControlData.current] !==
        data[key as keyof typeof data],
    );
    if (!hasChanged) return;

    if (JSON.stringify(lastControlData.current) === JSON.stringify(data)) return;

    // Only get the keys which are in the controls data
    const newData = Object.fromEntries(Object.entries(data).filter(([key]) => keys.includes(key)));
    // Prevent other effects from running
    lastControlData.current = newData as typeof lastControlData.current;
    set(newData as Parameters<typeof set>[0]);
    console.debug("[NODE-CONTROLS] <useEffect>", lastControlData.current, {
      data,
      newData,
    });
    // flowChanged();
  }, [data, set]);

  return { render, set, setNodeData };
};

/**
 * Forces to delete rendered handles, and connected edges, from a node
 */
export function useDeleteHandles() {
  const id = useNodeId();
  const flowDoc = useFlowStore((state) => state.flowDoc);
  const onEdgesChange = useFlowStore((state) => state.onEdgesChange);
  const updateNodeInternals = useUpdateNodeInternals();

  const deleteHandles = useCallback(
    (handles: string[]) => {
      if (!flowDoc) return;

      // Find edges connected to the specified handles on this node
      const edges = flowDoc.getEdges();
      const edgesToRemove = edges.filter(
        (edge) =>
          (edge.source === id && edge.sourceHandle && handles.includes(edge.sourceHandle)) ||
          (edge.target === id && edge.targetHandle && handles.includes(edge.targetHandle)),
      );

      // Remove each edge by its actual edge ID
      if (edgesToRemove.length > 0) {
        onEdgesChange(edgesToRemove.map((edge) => ({ id: edge.id, type: "remove" })));
      }

      updateNodeInternals(id); // for xyflow to apply the changes of the removed handles
    },
    [id, flowDoc, onEdgesChange, updateNodeInternals],
  );

  return deleteHandles;
}

type ContainerProps<T extends Record<string, unknown>> = BaseNode<T>;

const NodeContainerContext = createContext<ContainerProps<Record<string, unknown>>>(
  {} as ContainerProps<Record<string, unknown>>,
);

const useNode = <T extends Record<string, unknown>>() =>
  useContext(NodeContainerContext as React.Context<ContainerProps<T>>);

export const useNodeId = () => {
  const { id } = useNode();
  return id;
};

export const useNodeData = <T extends Record<string, any>>() => {
  const { data } = useNode<T>();
  return data;
};

export function NodeContainer(
  props: PropsWithChildren & BaseNode & { error?: string } & { className?: string },
) {
  return (
    <NodeContainerContext.Provider value={props}>
      <Card
        className={node({
          className: props.className,
          draggable: props.draggable,
          selected: props.selected,
          hasError: !!props.error,
        })}
      >
        <NodeHeader error={props.error} />
        <CardContent className="min-h-32 flex justify-center items-center">
          {props.children}
        </CardContent>
      </Card>
    </NodeContainerContext.Provider>
  );
}

export function BlankNodeContainer(props: PropsWithChildren & BaseNode) {
  return (
    <NodeContainerContext.Provider value={props}>{props.children}</NodeContainerContext.Provider>
  );
}

const node = cva(
  "border-none backdrop-blur-sm min-w-80 transition-all duration-300 bg-muted-foreground/10 rounded-md",
  {
    variants: {
      draggable: { true: "active:cursor-grabbing", false: "" },
      hasError: { true: "bg-red-500/5 dark:bg-red-500/20 ring-4 ring-red-500/80", false: "" },
      selected: { true: "ring-4 ring-blue-500/80 dark:bg-blue-500/5 bg-blue-500/10", false: "" },
    },
    defaultVariants: {
      selected: false,
      draggable: false,
      hasError: false,
    },
  },
);

/**
 * Conceptual buckets for how people scan a node list.
 * Internal nodes are not exposed to the end-user.
 */
type NodeGroup = "sense" | "generate" | "shape" | "decide" | "express" | "internal";
/**
 * Eight core tags for tooltips, docs, search, and AI.
 * Answer: What kind of signal? Does time matter? Does it keep state?
 */
export type NodeTag =
  | "value"
  | "trigger"
  | "time-based"
  | "stateful"
  | "source"
  | "action"
  | "logic"
  | "external";

export type BaseNode<Data extends Record<string, unknown> = {}> = NodeProps<
  Node<
    Data & {
      group: NodeGroup;
      tags: NodeTag[];
      icon: IconName;
      subType?: string;
      label: string;
      description: string;
    }
  >
>;
