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
                ? HANDLE_SPACING * (props.offset ?? 0)
                : 0,
              marginTop: [Position.Left, Position.Right].includes(
                props.position,
              )
                ? HANDLE_SPACING * (props.offset ?? 0)
                : 0,
              borderWidth: 2,
              borderColor: "white",
              backgroundColor: "#09090b",
              ...props.style,
            }}
          />
        </TooltipTrigger>
        <TooltipContent className="text-center">
          <p>{props.title ?? props.id}</p>
          {props.hint && <p className="opacity-60">{props.hint}</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type Props = HandleProps & {
  offset?: number;
  hint?: string;
};
