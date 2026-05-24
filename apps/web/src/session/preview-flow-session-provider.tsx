import { useEffect, useState, type ReactNode } from "react";
import type { FlowEdge, FlowNode } from "@microflow/collab";
import { FlowSessionProvider } from "./flow-session-context";
import { createPreviewSession } from "./preview-session";

/**
 * Wraps `children` in a `FlowSessionProvider` backed by a throwaway preview
 * session, so node components rendered in a read-only thumbnail (cards,
 * template previews) can call `useFlowSession()` without crashing.
 *
 * The session is constructed once per mount (`useState` lazy init) and
 * destroyed on unmount. If the caller needs the session to follow
 * changing `nodes`/`edges`, re-key the provider at the parent — within
 * a single mount the session is stable.
 */
export function PreviewFlowSessionProvider({
  nodes,
  edges,
  children,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  children: ReactNode;
}) {
  const [session] = useState(() => createPreviewSession(nodes, edges));
  useEffect(() => () => session.destroy(), [session]);
  return <FlowSessionProvider session={session}>{children}</FlowSessionProvider>;
}
