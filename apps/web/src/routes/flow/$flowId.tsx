import { ReactFlowCanvas } from "@/components/flow/react-flow-canvas";
import { authClient } from "@/lib/auth-client";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import { useFlowStore, useFlowDocument } from "@/stores/flow-store";
import { useSyncProvider, useCollabPresence } from "@/hooks/use-sync-provider";
import { trpc } from "@/utils/trpc";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { Loader2 } from "lucide-react";
import { env } from "@microflow/env/web";

export const Route = createFileRoute("/flow/$flowId")({
  component: RouteComponent,
  beforeLoad: async ({ params }) => {
    const session = await authClient.getSession();

    // Redirect to login if not authenticated
    if (!session.data) {
      throw redirect({
        to: "/login",
        search: { redirect: `/flow/${params.flowId}` },
      });
    }

    const { data: customerState } = await authClient.customer.state();
    return { session, customerState };
  },
});

function RouteComponent() {
  const { flowId } = Route.useParams();
  const { session } = Route.useRouteContext();
  const setActiveFlowId = useActiveFlowStore((s) => s.setActiveFlowId);
  const flowDoc = useFlowDocument();

  // Track initialization state to prevent double-init
  const initializedFlowId = useRef<string | null>(null);

  // Derive WebSocket URL from server URL
  const wsUrl = useMemo(() => {
    const serverUrl = new URL(env.VITE_SERVER_URL);
    serverUrl.protocol = serverUrl.protocol === "https:" ? "wss:" : "ws:";
    return serverUrl.origin;
  }, []);

  // Fetch flow metadata
  const {
    data: flow,
    isLoading,
    error,
  } = useQuery({
    ...trpc.flow.get.queryOptions({ id: flowId }),
  });

  // Set active flow ID when route loads
  useEffect(() => {
    setActiveFlowId(flowId);
    return () => {
      setActiveFlowId(null);
    };
  }, [flowId, setActiveFlowId]);

  // Initialize the flow document with data from server
  useEffect(() => {
    if (!flow) return;

    // Prevent re-initialization for the same flow
    if (initializedFlowId.current === flowId) return;

    const initCloudFlow = useFlowStore.getState().initCloudFlow;

    if (flow.ydocBase64) {
      const ydocData = Uint8Array.from(atob(flow.ydocBase64), (c) => c.charCodeAt(0));
      initCloudFlow(flowId, ydocData, {
        name: flow.name,
        description: flow.description ?? undefined,
      });
    } else {
      initCloudFlow(flowId, undefined, {
        name: flow.name,
        description: flow.description ?? undefined,
      });
    }

    initializedFlowId.current = flowId;

    // Cleanup when leaving the route
    return () => {
      console.log(`[FLOW-ROUTE] Leaving flow ${flowId}, cleaning up...`);
      initializedFlowId.current = null;
      useFlowStore.getState().destroy();
    };
  }, [flowId, flow?.ydocBase64]);

  // Fetch user profile settings
  const { data: profile } = useQuery({
    ...trpc.profile.get.queryOptions(),
    enabled: !!session.data,
  });

  // User info for sync provider - memoized to prevent reconnections
  const user = useMemo(
    () => ({
      id: session.data!.user.id,
      name: session.data!.user.name ?? "Anonymous",
      color: profile?.settings.collabColor,
      icon: profile?.settings.collabIcon,
    }),
    [
      session.data?.user.id,
      session.data?.user.name,
      profile?.settings.collabColor,
      profile?.settings.collabIcon,
    ],
  );

  // Connect to sync provider for real-time collaboration
  const sync = useSyncProvider({
    flowDoc,
    flowId,
    user,
    wsUrl,
    enabled: !!flowDoc && !!flow,
  });

  // Get presence info
  const presence = useCollabPresence(sync);
  console.log(new Date().toISOString(), presence);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive">Failed to load flow</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <ReactFlowCanvas updateCursor={sync.updateCursor} otherUsers={presence.otherUsers} />
    </ReactFlowProvider>
  );
}
