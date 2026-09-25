// "You cannot use this here" markers, in the places a user meets the thing
// before it disappoints them.
//
// Two kinds, one look. `DesktopOnlyBadge` is per node *type* — a capability the
// browser sandbox withholds. `ProviderBadge` is per LLM *configuration* — a
// provider that cannot serve the surface it is being offered on. Both are
// resolved by `hostLimitation` and render nothing when there is nothing to
// say, so callers can place them unconditionally.

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { hostLimitation, type ProviderSurface } from "./browser-support";

/** The shared look: a small outlined chip whose tooltip carries the why. */
export function HostBadge({ label, reason }: { label: string; reason: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            className="shrink-0 cursor-help border-sky-500/40 text-sky-600 dark:text-sky-400"
          >
            {label}
          </Badge>
        }
      />
      <TooltipContent className="max-w-xs">{reason}</TooltipContent>
    </Tooltip>
  );
}

export function DesktopOnlyBadge({ type }: { type: string | undefined }) {
  const limitation = hostLimitation({ kind: "node", type });
  if (limitation === undefined) return null;

  return <HostBadge label={limitation.label} reason={limitation.reason} />;
}

/** Why the chosen LLM configuration will not work on this surface. */
export function ProviderBadge({
  provider,
  surface,
}: {
  provider: { kind?: string; baseUrl?: string } | undefined;
  surface: ProviderSurface;
}) {
  const limitation = hostLimitation({ kind: "provider", provider, surface });
  if (limitation === undefined) return null;

  return <HostBadge label={limitation.label} reason={limitation.reason} />;
}
