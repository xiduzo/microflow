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
import { useShallow } from "zustand/react/shallow";
import { outgoingEdgeIdSelector, useNodesEdgesStore } from "../../../store";
import { useNode } from "./Node";

const HANDLE_SPACING = 40;

export function Handle(props: Props) {
  const { id, data } = useNode();
  const outgoingEdgeIds = useNodesEdgesStore(
    useShallow(outgoingEdgeIdSelector(id, props.id)),
  );

  const { updateEdge } = useReactFlow();

  const timeouts = useRef<Map<string, NodeJS.Timeout>>(new Map());

  useEffect(() => {
    if (props.type !== "source") return;
    if (!data.animated) return;
    if (props.id !== data.animated) return;

    outgoingEdgeIds.map((edgeId) => {
      const timeout = timeouts.current.get(edgeId);
      if (timeout) clearTimeout(timeout);

      updateEdge(edgeId, {
        animated: true,
      });

      timeouts.current.set(
        edgeId,
        setTimeout(() => {
          console.log("untriggering edge", edgeId);
          updateEdge(edgeId, {
            animated: false,
          });
        }, 150),
      );
    });
  }, [props.type, props.id, data.animated, outgoingEdgeIds, updateEdge]);

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
