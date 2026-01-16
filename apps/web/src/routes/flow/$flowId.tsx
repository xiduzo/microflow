import { ReactFlowCanvas } from "@/components/flow/ReactFlowCanvas";
import { authClient } from "@/lib/auth-client";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import { useFlowLoader } from "@/stores/flow-store";
import { trpc } from "@/utils/trpc";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Loader2, Users } from "lucide-react";
import { ShareFlowDialog } from "@/components/flow/share-flow-dialog";
import { Badge } from "@/components/ui/badge";
import { useCollabFlow } from "@/hooks/use-collab-flow";
import { env } from "@microflow/env/web";
import type { Node, Edge } from "@xyflow/react";

export const Route = createFileRoute("/flow/$flowId")({
  component: CloudFlowComponent,
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

function CloudFlowComponent() {
  const { flowId } = Route.useParams();
  const { session } = Route.useRouteContext();
  const setActiveFlowId = useActiveFlowStore((s) => s.setActiveFlowId);
  const { loadCloudFlow, currentFlowId } = useFlowLoader();

  // Derive WebSocket URL from server URL
  const wsUrl = useMemo(() => {
    const serverUrl = new URL(env.VITE_SERVER_URL);
    serverUrl.protocol = serverUrl.protocol === "https:" ? "wss:" : "ws:";
    return serverUrl.origin;
  }, []);

  // Fetch flow data
  const { data: flow, isLoading, error } = useQuery({
    ...trpc.flow.get.queryOptions({ id: flowId }),
  });

  // Set active flow ID when route loads
  useEffect(() => {
    setActiveFlowId(flowId);
  }, [flowId, setActiveFlowId]);

  // Load nodes/edges into the flow store when flow data is fetched
  useEffect(() => {
    if (flow && currentFlowId !== flowId) {
      loadCloudFlow(
        flowId, 
        (flow.nodes ?? []) as Node[], 
        (flow.edges ?? []) as Edge[]
      );
    }
  }, [flow, flowId, loadCloudFlow, currentFlowId]);

  // Connect to collaboration WebSocket
  useCollabFlow({
    flowId,
    userId: session.data!.user.id,
    userName: session.data!.user.name ?? "Anonymous",
    wsUrl,
  });

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
      <div className="relative h-full">
        {/* Flow info header */}
        <div className="absolute top-4 left-4 z-10 bg-background/80 backdrop-blur-sm rounded-lg px-3 py-2 border flex items-center gap-3">
          <div>
            <h2 className="font-medium">{flow?.name}</h2>
            {flow?.description && (
              <p className="text-xs text-muted-foreground">{flow.description}</p>
            )}
          </div>
          {flow?.collaborators && flow.collaborators.length > 0 && (
            <Badge variant="secondary" className="gap-1">
              <Users className="size-3" />
              {flow.collaborators.length + 1}
            </Badge>
          )}
          {flow?.isOwner && (
            <ShareFlowDialog flowId={flowId} flowName={flow.name} />
          )}
        </div>
        <ReactFlowCanvas />
      </div>
    </ReactFlowProvider>
  );
}
