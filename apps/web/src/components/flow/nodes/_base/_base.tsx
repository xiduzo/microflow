import { type Node, type NodeProps } from "@xyflow/react";
import { createContext, type PropsWithChildren, useContext } from "react";
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
import { usePins } from "@/stores/board";
import { Pin, pinDisplayValue } from "@/components/hardware/pin";
import { Icon, type IconName } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";

// Re-exports so existing callers (`from "../_base/_base"`) keep working transparently.
// Hook implementations live in their own modules to keep the layout file focused.
export { useNodeControls, type Controls } from "./use-node-controls";
export { useDeleteHandles } from "./use-delete-handles";

function NodeHeader(props: { error?: string }) {
  const data = useNodeData();

  return (
    <CardHeader className="flex items-center gap-2">
      <div className={groupIndicator({ group: data.group })}>
        <Icon icon={data.icon} />
      </div>
      <section className="grow overflow-hidden">
        <CardTitle className="truncate whitespace-nowrap">
          {data.label}
        </CardTitle>
        <NodeDescription />
      </section>
      {data.beta === true && (
        <Badge
          variant="outline"
          className="shrink-0 border-amber-500/40 text-amber-600 dark:text-amber-500"
        >
          beta
        </Badge>
      )}
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

export const groupIndicator = cva("size-9 min-w-9 rounded-sm flex items-center justify-center", {
  variants: {
    group: {
      sense: "text-red-900 bg-red-500/30 dark:text-red-200 dark:bg-red-600/30",
      generate: "text-yellow-900 bg-yellow-500/30 dark:text-yellow-200 dark:bg-yellow-600/30",
      shape: "text-emerald-900 bg-emerald-500/30 dark:text-emerald-200 dark:bg-emerald-600/30",
      decide: "text-sky-900 bg-sky-500/30 dark:text-sky-200 dark:bg-sky-600/30",
      express: "text-violet-900 bg-violet-500/30 dark:text-violet-200 dark:bg-violet-600/30",
      internal: "text-pink-900 bg-pink-500/30 dark:text-pink-200 dark:bg-pink-600/30",
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
              {key}: {pinDisplayValue(value as string, pins)}
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

type ContainerProps<T extends Record<string, unknown>> = BaseNode<T>;

const NodeContainerContext = createContext<ContainerProps<Record<string, unknown>>>(
  {} as ContainerProps<Record<string, unknown>>,
);

/** Internal accessor for everything the container provides. Hook modules use this
 *  to read id/data/selected/etc. without each one re-deriving the context shape. */
export const useNode = <T extends Record<string, unknown>>() =>
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
  "border-none backdrop-blur-sm min-w-80 transition-all duration-300 bg-card rounded-md",
  {
    variants: {
      draggable: { true: "active:cursor-grabbing", false: "" },
      hasError: { true: "bg-red-500/5 dark:bg-red-500/20 ring-4 ring-red-500/80", false: "" },
      selected: { true: "ring-4 ring-orange-500/80 dark:bg-orange-500/5 bg-orange-500/10", false: "" },
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
