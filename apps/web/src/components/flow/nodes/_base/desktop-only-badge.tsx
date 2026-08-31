// The "this node needs the desktop app" marker, in the two places a user meets
// a node: the Add Node list (before dropping it) and the node header (after).
// Renders nothing when the current host can run the node — on desktop always,
// and in a browser that happens to have the capability.

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { browserLimitation } from "./browser-support";

export function DesktopOnlyBadge({ type }: { type: string | undefined }) {
  const reason = browserLimitation(type);
  if (reason === undefined) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            className="shrink-0 cursor-help border-sky-500/40 text-sky-600 dark:text-sky-400"
          >
            desktop only
          </Badge>
        }
      />
      <TooltipContent className="max-w-xs">{reason}</TooltipContent>
    </Tooltip>
  );
}
