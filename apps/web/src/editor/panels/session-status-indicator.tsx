import { memo } from "react";
import { isRemoteSyncAdapter, useFlowSession, useFlowSessionStatus } from "@/session";
import { Button } from "@/ui/button";
import { cn } from "@/ui/utils";
import { describeSessionStatus, type SessionStatusTone } from "../session-status-copy";

const DOT: Record<SessionStatusTone, string> = {
  neutral: "bg-muted-foreground",
  busy: "bg-sky-500 animate-pulse",
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-destructive",
};

/**
 * The Flow Session Status in the editor header: connected, saving, offline
 * with unsynced changes, view only, access lost. Hidden for local flows.
 *
 * A polite live region, so a screen reader hears "Offline" or "Access
 * removed" without the label stealing focus; the detail rides along as the
 * title and accessible description.
 */
export const SessionStatusIndicator = memo(function SessionStatusIndicator() {
  const session = useFlowSession();
  const status = useFlowSessionStatus();
  const copy = describeSessionStatus(status);
  if (!copy) return null;

  const retry = copy.canRetry && isRemoteSyncAdapter(session.sync) ? session.sync : null;

  return (
    <div
      role="status"
      aria-live="polite"
      title={copy.detail}
      className="flex items-center gap-2 rounded-full border bg-background/80 py-1 pl-3 pr-1 text-xs font-medium backdrop-blur"
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[copy.tone])} />
      <span>{copy.label}</span>
      <span className="sr-only">{copy.detail}</span>
      {retry ? (
        <Button size="xs" variant="ghost" onClick={() => retry.reconnect()}>
          Retry
        </Button>
      ) : (
        <span className="w-2" />
      )}
    </div>
  );
});
