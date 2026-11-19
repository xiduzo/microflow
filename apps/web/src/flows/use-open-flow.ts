import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";

import { authClient } from "@/account/auth-client";
import { saveLocalFlow } from "@/session";
import { useActiveFlowStore } from "./active-flow";
import {
  openFlowFromContent,
  type FlowContent,
  type FlowDestination,
  type OpenedFlow,
} from "./open-flow";

/**
 * `openFlowFromContent` bound to this app: the auth session says who is signed
 * in, the local flow is the session's, and the editor is the graph route.
 *
 * The returned function resolves once the flow has landed and the editor has
 * been asked to show it, or with `ok: false` when landing failed; it does not
 * throw. What to tell the user either way is the caller's.
 */
export function useOpenFlow(): (
  content: FlowContent,
  destination: FlowDestination,
) => Promise<OpenedFlow> {
  const navigate = useNavigate();
  const setActiveFlowId = useActiveFlowStore((s) => s.setActiveFlowId);
  const { data: session } = authClient.useSession();
  const signedIn = !!session?.user;

  return useCallback(
    (content, destination) =>
      openFlowFromContent(content, destination, {
        signedIn,
        saveLocalFlow,
        setActiveFlowId,
        navigate: (flowId) => {
          void navigate({ to: "/flow/$flowId/graph", params: { flowId } });
        },
      }),
    [signedIn, setActiveFlowId, navigate],
  );
}
