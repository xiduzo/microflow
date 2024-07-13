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
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  baseEdgeConfig,
  incommingEdgeSelector,
  useNodesEdgesStore,
} from "../../../store";
import { useNode } from "./Node";

const HANDLE_SPACING = 40;

export function Handle(props: Props) {
  const { id, data } = useNode();

  const { outgoingEdges } = useNodesEdgesStore(
    useShallow(incommingEdgeSelector(id, props.id)),
  );
  const { updateEdge } = useReactFlow();

  const [isTriggered, setIsTriggered] = useState(false);

  const timeout = useRef<NodeJS.Timeout>();

  const triggerHandle = useCallback(() => {
    setIsTriggered(true);
    if (timeout.current) clearTimeout(timeout.current);

    timeout.current = setTimeout(() => {
      setIsTriggered(false);
    }, 150);
  }, []);

  useEffect(() => {
    if (props.type !== "source") return;
    if (!data.animated) return;
    if (props.id !== data.animated) return;

    triggerHandle();

    outgoingEdges.forEach((edge) => {
      updateEdge(edge.id, {
        animated: true,
        style: { ...baseEdgeConfig.style, stroke: "#f97316" },
      });

      setTimeout(() => {
        updateEdge(edge.id, {
          animated: false,
          style: baseEdgeConfig.style,
        });
      }, 75);
    });
  }, [props.type, props.id, data.animated, triggerHandle, outgoingEdges]);

  useEffect(() => {
    if (props.type !== "target") return;
    if (props.id !== data.animated) return;

    triggerHandle();
  }, [props.type, props.id, data.animated]);

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
              borderColor: isTriggered ? "#f59e0b" : "white",
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
