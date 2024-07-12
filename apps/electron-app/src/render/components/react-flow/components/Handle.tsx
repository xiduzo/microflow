import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@fhb/ui";
import { HandleProps, Position, Handle as XyFlowHandle } from "@xyflow/react";

const HANDLE_SPACING = 40;

export function Handle(props: Props) {
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
