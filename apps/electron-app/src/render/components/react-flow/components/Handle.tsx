import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@fhb/ui";
import { HandleProps, Handle as XyFlowHandle } from "@xyflow/react";

export function Handle(props: Props) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <XyFlowHandle {...props} />
        </TooltipTrigger>
        <TooltipContent>
          <p>{props.title ?? props.id}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type Props = HandleProps & {};
