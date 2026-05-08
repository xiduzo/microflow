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

const HANDLE_SIZE = 18;
const HANDLE_TRANSLATE_OFFSET = HANDLE_SIZE * 0.9;

const HANDLE_SPACING_OFFSET = 14;
const HANDLE_SPACING = HANDLE_SIZE * 1.5;

export function Handle(props: Props) {
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

type Props = Omit<HandleProps, "isConnectable" | "isValidConnection" | "position"> & {
  offset?: number;
  hint?: string;
  isConnectable?: ((edges: Edge[]) => boolean) | boolean;
  isValidConnection?: (edges: Edge[], edge: Edge | Connection) => boolean;
  position: PositionType;
  handleType?: HandleType;
};

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
