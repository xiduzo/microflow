import { CLOSE_ACCESS_DENIED, CLOSE_FLOW_GONE, CLOSE_POLICY_VIOLATION } from "@microflow/collab";
import type { FlowSessionStatus } from "@/session";

export type SessionStatusTone = "neutral" | "busy" | "good" | "warn" | "bad";

export type SessionStatusCopy = {
  /** Short, always visible. */
  label: string;
  /** The longer explanation for the tooltip and assistive tech. */
  detail: string;
  tone: SessionStatusTone;
  /** Whether a manual retry is worth offering. */
  canRetry: boolean;
};

function changes(n: number): string {
  return `${n} unsynced change${n === 1 ? "" : "s"}`;
}

/** Who refused, by close code (see `protocol.ts`), with the reason as a fallback. */
function accessLostCopy(
  lost: FlowSessionStatus["accessLost"],
): { label: string; detail: string; canRetry: boolean } {
  const code = lost?.code;
  const reason = lost?.reason ?? "";
  if (code === CLOSE_FLOW_GONE) {
    return { label: "Flow deleted", detail: "This flow was deleted.", canRetry: false };
  }
  if (code === CLOSE_ACCESS_DENIED) {
    return {
      label: "Access removed",
      detail: "Your access to this flow was removed.",
      canRetry: false,
    };
  }
  if (code === CLOSE_POLICY_VIOLATION && !/forbidden/i.test(reason)) {
    return {
      label: "Signed out",
      detail: "Your session expired. Sign in again, then retry.",
      canRetry: true,
    };
  }
  return {
    label: "No access",
    detail: "You don't have access to this flow.",
    canRetry: true,
  };
}

/** What the editor header says for a Flow Session Status. `null` hides it. */
export function describeSessionStatus(status: FlowSessionStatus): SessionStatusCopy | null {
  switch (status.kind) {
    case "local":
      return null;
    case "local-unsaved":
      return {
        label: "Not saving locally",
        detail: `${status.localError ?? "Local storage is unavailable."} Changes you make now will be lost when you close this tab — export the flow to keep them.`,
        tone: "bad",
        canRetry: false,
      };
    case "connecting":
      return { label: "Connecting…", detail: "Connecting to the flow.", tone: "busy", canRetry: false };
    case "syncing":
      return {
        label: "Syncing…",
        detail: "Bringing your copy of the flow up to date.",
        tone: "busy",
        canRetry: false,
      };
    case "connected":
      return { label: "Connected", detail: "Live with your collaborators.", tone: "good", canRetry: false };
    case "saving":
      if (status.saveFailing) {
        return {
          label: "Not saved yet",
          detail:
            "The server could not store the latest changes and is retrying. Keep this tab open until it says Saved.",
          tone: "warn",
          canRetry: false,
        };
      }
      return { label: "Saving…", detail: "Your changes are being stored.", tone: "busy", canRetry: false };
    case "saved":
      return { label: "Saved", detail: "All changes are stored.", tone: "good", canRetry: false };
    case "read-only": {
      const n = status.unsyncedChanges;
      if (n > 0) {
        const these = n === 1 ? "1 local change" : `${n} local changes`;
        return {
          label: `View only · ${these} not saved`,
          detail: `You have view access to this flow now, so ${these} made on this device can't be saved. Export the flow to keep them; reloading discards them.`,
          tone: "warn",
          canRetry: false,
        };
      }
      return {
        label: "View only",
        detail: "You can look around, but you can't change this flow.",
        tone: "neutral",
        canRetry: false,
      };
    }
    case "offline": {
      const n = status.unsyncedChanges;
      if (status.serverRestarting) {
        return {
          label: n > 0 ? `Server restarting · ${changes(n)}` : "Server restarting",
          detail: "The server is restarting. Reconnecting automatically.",
          tone: "busy",
          canRetry: false,
        };
      }
      return {
        label: n > 0 ? `Offline · ${changes(n)}` : "Offline",
        detail:
          n > 0
            ? `Reconnecting. ${changes(n)} will sync when the connection is back — reloading this page loses them.`
            : "Reconnecting. Changes you make now will sync when the connection is back.",
        tone: "warn",
        canRetry: true,
      };
    }
    case "access-lost": {
      const { label, detail, canRetry } = accessLostCopy(status.accessLost);
      const n = status.unsyncedChanges;
      const lost = n > 0 ? ` ${changes(n)} could not be saved.` : "";
      return { label, detail: `${detail} Editing is paused.${lost}`, tone: "bad", canRetry };
    }
  }
}
