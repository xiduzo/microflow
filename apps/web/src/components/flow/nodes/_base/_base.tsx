import { type Node, type NodeProps } from "@xyflow/react";
import { type PropsWithChildren, useRef } from "react";
import { shallow } from "zustand/shallow";
import { NodeContainerContext, type NodeContainerProps, useNodeData } from "./node-context";
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
import { OctagonAlertIcon, TriangleAlertIcon, CableIcon } from "lucide-react";
import { usePins } from "@/stores/board";
import { Pin, pinDisplayValue } from "@/components/hardware/pin";
import { Icon, type IconName } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { DesktopOnlyBadge } from "./desktop-only-badge";

// Re-exports so existing callers (`from "../_base/_base"`) keep working transparently.
// Hook implementations live in their own modules to keep the layout file focused.
export { useNodeControls, type Controls } from "./use-node-controls";
export { useDeleteHandles } from "./use-delete-handles";
// The container context now lives in the leaf `./node-context` module, so a
// consumer that needs only `useNodeId` (the node-data store, on the hot event
// path) can import it without dragging in this file's UI dependency tree. Both
// paths stay valid — every existing `from "../_base/_base"` import is unchanged.
export { useNode, useNodeId, useNodeData } from "./node-context";

function NodeHeader(props: { error?: string; warning?: string; type?: string }) {
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
      {/* A capability the browser host cannot provide belongs to the node type,
          not to this node's config — so it is resolved here, once, rather than
          in each of the ~39 node modules. */}
      <DesktopOnlyBadge type={props.type} />
      {/* An error (red) outranks a warning (amber) — only one status icon shows. */}
      {props.error ? (
        <CardAction>
          <Tooltip>
            <TooltipTrigger className="cursor-help">
              <OctagonAlertIcon className="text-red-500" />
            </TooltipTrigger>
            <TooltipContent className="text-red-500">{props.error}</TooltipContent>
          </Tooltip>
        </CardAction>
      ) : props.warning ? (
        <CardAction>
          <Tooltip>
            <TooltipTrigger className="cursor-help">
              <TriangleAlertIcon className="text-amber-500" />
            </TooltipTrigger>
            <TooltipContent className="text-amber-600 dark:text-amber-500">
              {props.warning}
            </TooltipContent>
          </Tooltip>
        </CardAction>
      ) : null}
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

/**
 * Every context consumer re-renders when the provider value changes identity, so
 * the container must hand out the *same* object while the node props are
 * shallow-equal — a fresh `props` object per render would wake every
 * `useNodeData`/`useNodeId` consumer in the subtree on each parent render.
 */
function useStableNode(node: NodeContainerProps<Record<string, unknown>>) {
  const ref = useRef(node);
  if (!shallow(ref.current, node)) ref.current = node;
  return ref.current;
}

export function NodeContainer(
  props: PropsWithChildren &
    BaseNode & { error?: string; warning?: string } & { className?: string },
) {
  // `children` is a new element every render and the presentational props are
  // not part of the context shape — neither belongs in the provider value.
  const { children, error, warning, className, ...rest } = props;
  const value = useStableNode(rest);

  return (
    <NodeContainerContext.Provider value={value}>
      <Card
        className={node({
          className,
          draggable: rest.draggable,
          selected: rest.selected,
          hasError: !!error,
          // Error's red ring outranks the amber warning ring when both are set.
          hasWarning: !!warning && !error,
        })}
      >
        <NodeHeader error={error} warning={warning} type={rest.type} />
        <CardContent className="min-h-32 flex justify-center items-center">{children}</CardContent>
      </Card>
    </NodeContainerContext.Provider>
  );
}

export function BlankNodeContainer(props: PropsWithChildren & BaseNode) {
  const { children, ...rest } = props;
  const value = useStableNode(rest);

  return <NodeContainerContext.Provider value={value}>{children}</NodeContainerContext.Provider>;
}

const node = cva(
  "border-none backdrop-blur-sm min-w-80 transition-all duration-300 bg-card rounded-md",
  {
    variants: {
      draggable: { true: "active:cursor-grabbing", false: "" },
      hasError: { true: "bg-red-500/5 dark:bg-red-500/20 ring-4 ring-red-500/80", false: "" },
      hasWarning: { true: "bg-amber-500/5 dark:bg-amber-500/15 ring-4 ring-amber-500/70", false: "" },
      selected: { true: "ring-4 ring-orange-500/80 dark:bg-orange-500/5 bg-orange-500/10", false: "" },
    },
    defaultVariants: {
      selected: false,
      draggable: false,
      hasError: false,
      hasWarning: false,
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
