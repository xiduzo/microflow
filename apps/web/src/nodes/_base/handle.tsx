import {
  type HandleProps as XyHandleProps,
  Position,
  Handle as XyFlowHandle,
  type Edge,
  useReactFlow,
  useNodeId,
  useStore,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cva } from "class-variance-authority";
import {
  HANDLE_SIZE,
  HANDLE_SPACING,
  HANDLE_SPACING_OFFSET,
  HANDLE_TRANSLATE_OFFSET,
  isHandleNearPointer,
  subscribeToPointerProximity,
  type HandlePosition,
} from "@/editor/handle-proximity";
import { isValidHandleConnection, type HandleConnectionRule } from "./connection-validity";

/**
 * Hover affordance: subscribe to the shared, frame-coalesced pointer source
 * and read this handle's geometry from the ReactFlow store. No DOM
 * measurement, one listener for the whole canvas.
 */
function useHandleProximity(
  nodeId: string | null,
  position: HandlePosition,
  offset: number,
): boolean {
  const { getInternalNode, screenToFlowPosition, getZoom } = useReactFlow();
  const [isNear, setIsNear] = useState(false);

  useEffect(() => {
    if (!nodeId) return;
    return subscribeToPointerProximity({
      toFlow: screenToFlowPosition,
      getZoom,
      near: (pointerFlow, zoom) => {
        const node = getInternalNode(nodeId);
        if (!node) return false;
        return isHandleNearPointer({
          node: {
            x: node.internals.positionAbsolute.x,
            y: node.internals.positionAbsolute.y,
            width: node.measured.width ?? 0,
            height: node.measured.height ?? 0,
          },
          position,
          offset,
          pointer: pointerFlow,
          zoom,
        });
      },
      onChange: setIsNear,
    });
  }, [nodeId, position, offset, getInternalNode, screenToFlowPosition, getZoom]);

  return isNear;
}

/**
 * One handle on the canvas. Rendered only by `NodeHandles`, which decides
 * which handles a node has; this component decides how one looks and behaves.
 */
export function Handle(props: Props) {
  const { position, handleType: _handleType, offset: _offset, hint: _hint, ...restProps } = props;
  const { getEdges, getNode } = useReactFlow();

  const nodeId = useNodeId();
  const handleId = props.id;

  // Narrow subscriptions: both selectors return a boolean, so a handle
  // re-renders only when its own answer flips — not when the edge array
  // changes identity.
  const isHandleSelectedViaEdge = useStore(
    useCallback(
      (state: { edges: Edge[] }) =>
        state.edges.some(
          (edge) =>
            edge.selected &&
            ((edge.target === nodeId && edge.targetHandle === handleId) ||
              (edge.source === nodeId && edge.sourceHandle === handleId)),
        ),
      [nodeId, handleId],
    ),
  );

  const isConnectableProp = props.isConnectable;
  const isConnectable = useStore(
    useCallback(
      (state: { edges: Edge[] }) =>
        typeof isConnectableProp === "boolean"
          ? isConnectableProp
          : (isConnectableProp?.(state.edges) ?? true),
      [isConnectableProp],
    ),
  );

  const showHandle = useHandleProximity(nodeId, position, props.offset ?? 0);

  const translate = useMemo(() => {
    switch (position) {
      case "bottom":
        return `0 -${HANDLE_TRANSLATE_OFFSET}px`;
      case "left":
        return `${HANDLE_TRANSLATE_OFFSET}px`;
      case "right":
        return `-${HANDLE_TRANSLATE_OFFSET}px`;
    }
  }, [position]);

  const tooltipSide = useMemo(() => {
    // For bottom handles, show tooltip above so it appears closer to the label text.
    if (position === "bottom") return "top";
    return position;
  }, [position]);

  return (
    <Tooltip>
      <TooltipTrigger>
        <XyFlowHandle
          {...restProps}
          position={position as Position}
          isConnectable={isConnectable}
          isValidConnection={(edge) =>
            isValidHandleConnection(edge, getEdges(), getNode, props.isValidConnection)
          }
          className={handle({
            variant: props.handleType,
            position: position,
            className: props.className,
            isHandleSelectedViaEdge: isHandleSelectedViaEdge,
          })}
          style={{
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
            marginLeft: ["bottom"].includes(position)
              ? HANDLE_SPACING * 2 * (props.offset ?? 0)
              : 0,
            marginTop: ["left", "right"].includes(position)
              ? HANDLE_SPACING * (props.offset ?? 0) + HANDLE_SPACING_OFFSET
              : 0,
            translate,
            ...props.style,
          }}
        >
          <span
            className={handleText({
              position: position,
              showHandle: showHandle || isHandleSelectedViaEdge,
              isHandleSelectedViaEdge: isHandleSelectedViaEdge,
            })}
          >
            {String(props.title ?? props.id).toLowerCase()}
          </span>
        </XyFlowHandle>
      </TooltipTrigger>
      {props.hint && <TooltipContent side={tooltipSide}>{props.hint}</TooltipContent>}
    </Tooltip>
  );
}

type PositionType = `${Position.Left}` | `${Position.Right}` | `${Position.Bottom}`;

type HandleType = "value" | "event" | "command" | "state";

/** The props of {@link Handle}. */
export type HandleProps = Props;

type Props = Omit<XyHandleProps, "isConnectable" | "isValidConnection" | "position" | "id" | "type"> & {
  /** `target` for a **Port** (edges come in), `source` for an **Emit** (edges go out). */
  type: "target" | "source";
  id: string;
  offset?: number;
  hint?: string;
  isConnectable?: ((edges: Edge[]) => boolean) | boolean;
  isValidConnection?: HandleConnectionRule;
  position: PositionType;
  handleType?: HandleType;
};

/**
 * What a node may still say about one of its handles at render time, through
 * `<NodeHandles>`: the things that depend on the host rather than on the
 * node's settings, such as whether the connected board's pin can drive it.
 * Which handles exist and how they are laid out is the node's Handle Rule.
 */
export type HandleOverride = Pick<Props, "hint" | "isConnectable" | "isValidConnection">;

const handle = cva("text-xs flex z-50 shadow-none after:content-[''] after:absolute after:leading-3 after:top-0 after:left-0 after:w-full after:h-full after:bg-transparent", {
  variants: {
    position: {
      left: "items-center justify-start",
      right: "items-center justify-end",
      top: "justify-center",
      bottom: "justify-center",
    },
    variant: {
      value: "after:content-['●'] after:text-2xl after:-ml-px",
      event: "after:content-['◆'] after:text-3xl after:-mt-[2px]",
      command: "after:content-['▶'] after:text-2xl after:-ml-[1px] after:-mt-px",
      state: "after:content-['■'] after:text-2xl",
    },
    isHandleSelectedViaEdge: {
      true: "selected-via-edge",
      false: "",
    },
  },
  defaultVariants: {
    variant: "event",
  },
});

const handleText = cva("pointer-events-none mb-1 transition-all whitespace-nowrap", {
  variants: {
    position: {
      left: "translate-x-6",
      right: "-translate-x-6",
      top: "translate-y-6",
      bottom: "-translate-y-6",
    },
    showHandle: {
      true: "opacity-100",
      false: "opacity-0",
    },
    isHandleSelectedViaEdge: {
      true: "selected-via-edge",
      false: "",
    },
  },
});
