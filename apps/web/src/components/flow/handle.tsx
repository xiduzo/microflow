import {
  type HandleProps,
  Position,
  Handle as XyFlowHandle,
  type Edge,
  type Connection,
  useReactFlow,
  useNodeId,
  useStore,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cva } from "class-variance-authority";
import type { ComponentType, EmitOf, PortOf } from "./nodes/_base/_base.types";
import {
  HANDLE_SIZE,
  HANDLE_SPACING,
  HANDLE_SPACING_OFFSET,
  HANDLE_TRANSLATE_OFFSET,
  isHandleNearPointer,
  subscribeToPointerProximity,
  type HandlePosition,
} from "./handle-proximity";

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

export function Handle<T extends ComponentType = ComponentType>(props: Props<T>) {
  const { position, handleType: _handleType, offset: _offset, hint: _hint, ...restProps } = props;
  const { getEdges } = useReactFlow();

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
          isValidConnection={(edge) => {
            if (props.isValidConnection) props.isValidConnection(getEdges(), edge);

            // Can not connect to self
            if (edge.source === edge.target) return false;
            return true;
          }}
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

/**
 * Shared props for both target (input) and source (output) handles.
 */
type CommonProps = Omit<
  HandleProps,
  "isConnectable" | "isValidConnection" | "position" | "id" | "type"
> & {
  offset?: number;
  hint?: string;
  isConnectable?: ((edges: Edge[]) => boolean) | boolean;
  isValidConnection?: (edges: Edge[], edge: Edge | Connection) => boolean;
  position: PositionType;
  handleType?: HandleType;
};

/**
 * Target (input) handle — receives flow edges. `id` must be a declared **Port**
 * of the parent Component. When `<Handle>` is called without binding the
 * generic, `T` defaults to the union of every catalogued Component, so `id`
 * must at minimum match _some_ Port in the catalog — typos against the
 * aggregate port set fail at compile time. Bind the generic explicitly
 * (`<Handle<"Led"> ...>`) for per-Component tightening that catches
 * cross-Component port confusion too.
 *
 * Mirrors `Component::dispatch`'s Port surface in the Rust runtime. See
 * `CONTEXT.md` § Port and ADR-0001.
 */
type TargetProps<T extends ComponentType> = CommonProps & {
  type: "target";
  id: PortOf<T>;
};

/**
 * Source (output) handle — emits flow edges. `id` must be a declared **Emit**
 * of the parent Component (the handle it passes to `ComponentBase::emit`). When
 * `<Handle>` is used without binding the generic, `T` defaults to the union of
 * every catalogued Component, so `id` must at minimum match _some_ Emit in the
 * catalog — typos against the aggregate emit set fail at compile time. Bind the
 * generic explicitly (`<Handle<"Button"> ...>`) for per-Component tightening
 * that catches cross-Component emit confusion too.
 *
 * Mirrors `Component::emits()` in the Rust runtime. See `CONTEXT.md` § Emit and
 * ADR-0007.
 */
type SourceProps<T extends ComponentType> = CommonProps & {
  type: "source";
  id: EmitOf<T>;
};

export type HandleProps_<T extends ComponentType = ComponentType> =
  | TargetProps<T>
  | SourceProps<T>;
type Props<T extends ComponentType = ComponentType> = HandleProps_<T>;

/**
 * Per-handle presentational props a node supplies via `<NodeHandles>` — the
 * bits the generated wire-interface contract (COMPONENT_PORTS / COMPONENT_EMITS)
 * can't know: `offset`, `title`, `hint`, `handleType`, `isConnectable`,
 * `position`, … `type` and `id` are intentionally excluded — those are driven
 * by the contract. Everything is optional, so a contract handle with no
 * override still renders with the `NodeHandles` defaults.
 */
export type HandleOverride = Partial<CommonProps>;

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
