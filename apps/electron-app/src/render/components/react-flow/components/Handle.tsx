import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@fhb/ui";
import {
  HandleProps,
  Position,
  useReactFlow,
  Handle as XyFlowHandle,
} from "@xyflow/react";
import { useEffect, useRef } from "react";
import { useNode } from "./Node";

const HANDLE_SPACING = 40;

export function Handle(props: Props) {
  const { id, data } = useNode();

  const { updateEdge, getEdges } = useReactFlow();

  const timeouts = useRef<Map<string, NodeJS.Timeout>>(new Map());

  useEffect(() => {
    if (props.type !== "source") return;

    if (!data.animated) return;
    if (props.id !== data.animated) return;

    const edges = getEdges().filter(
      (edge) => edge.source === id && edge.sourceHandle === props.id,
    );
    edges.map((edge) => {
      const timeout = timeouts.current.get(edge.id);
      if (timeout) clearTimeout(timeout);

      updateEdge(edge.id, { animated: true });

      timeouts.current.set(
        edge.id,
        setTimeout(() => {
          updateEdge(edge.id, { animated: false });
        }, 150),
      );
    });
  }, [id, props.type, props.id, data.animated, getEdges, updateEdge]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <XyFlowHandle
            {...props}
            style={{
              width: 20,
              height: 20,
              marginLeft: [Position.Top, Position.Bottom].includes(
                props.position,
              )
                ? HANDLE_SPACING * (props.index ?? 0)
                : 0,
              marginTop: [Position.Left, Position.Right].includes(
                props.position,
              )
                ? HANDLE_SPACING * (props.index ?? 0)
                : 0,
              borderWidth: 2,
              borderColor: "white",
              backgroundColor: "#09090b",
              ...props.style,
            }}
          />
        </TooltipTrigger>
        <TooltipContent>
          <p>{props.title ?? props.id}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type Props = HandleProps & {
  index?: number;
};
