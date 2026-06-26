import {
  type HandleProps,
  Position,
  Handle as XyFlowHandle,
  type Edge,
  type Connection,
  useEdges,
  useReactFlow,
  useNodeId,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cva } from "class-variance-authority";
import type { ComponentType, EmitOf, PortOf } from "./nodes/_base/_base.types";

const HANDLE_SIZE = 18;
const HANDLE_TRANSLATE_OFFSET = HANDLE_SIZE * 0.9;

const HANDLE_SPACING_OFFSET = 14;
const HANDLE_SPACING = HANDLE_SIZE * 1.5;

export function Handle<T extends ComponentType = ComponentType>(props: Props<T>) {
  const { position, handleType: _handleType, offset: _offset, hint: _hint, ...restProps } = props;
  const edges = useEdges();
  const ref = useRef<HTMLDivElement>(null);
  const { getZoom } = useReactFlow();
  const [showHandle, setShowHandle] = useState(false);

  const nodeId = useNodeId();
  const selectedEdges = useMemo(() => {
    return edges.filter(({ selected }) => selected);
  }, [edges]);
  const isHandleSelectedViaEdge = useMemo(() => {
    return !!selectedEdges.find(
      (edge) =>
        (edge.target === nodeId && edge.targetHandle === props.id) ||
        (edge.source === nodeId && edge.sourceHandle === props.id),
    );
  }, [selectedEdges, nodeId, props.id]);

  const isConnectable = useMemo(() => {
    return typeof props.isConnectable === "boolean"
      ? props.isConnectable
      : (props.isConnectable?.(edges) ?? true);
  }, [props.isConnectable, edges]);

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

  useEffect(() => {
    function handleMouseClose(event: MouseEvent) {
      const zoom = getZoom();
      if (zoom < 0.75) {
        setShowHandle(false);
        return;
      }

      if (!ref.current) return;

      const boundingBox = ref.current.getBoundingClientRect();
      const { clientX, clientY } = event;
      const { left, top, right, bottom } = boundingBox;
      const closestX = Math.max(left, Math.min(clientX, right));
      const closestY = Math.max(top, Math.min(clientY, bottom));
      const distance = Math.sqrt((clientX - closestX) ** 2 + (clientY - closestY) ** 2);
      const threshold = zoom * 200;
      setShowHandle(distance <= threshold);
    }

    window.addEventListener("mousemove", handleMouseClose);

    return () => {
      window.removeEventListener("mousemove", handleMouseClose);
    };
  }, [props.id, getZoom]);

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
          ref={ref}
          isConnectable={isConnectable}
          isValidConnection={(edge) => {
            if (props.isValidConnection) props.isValidConnection(edges, edge);

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
