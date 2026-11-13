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
      return { label: "Saving…", detail: "Your changes are being stored.", tone: "busy", canRetry: false };
    case "saved":
      return { label: "Saved", detail: "All changes are stored.", tone: "good", canRetry: false };
    case "read-only":
      return {
        label: "View only",
        detail: "You can look around, but you can't change this flow.",
        tone: "neutral",
        canRetry: false,
      };
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
      const reason = status.accessLost?.reason ?? "";
      const label = /unauthori[sz]ed/i.test(reason)
        ? "Signed out"
        : /revoked/i.test(reason)
          ? "Access removed"
          : "No access";
      const n = status.unsyncedChanges;
      const lost = n > 0 ? ` ${changes(n)} could not be saved.` : "";
      return {
        label,
        detail: `${reason || "The server refused the connection"}. Editing is paused.${lost}`,
        tone: "bad",
        canRetry: true,
      };
    }
  }
}
