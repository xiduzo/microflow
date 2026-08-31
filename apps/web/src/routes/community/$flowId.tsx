import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { formatDistanceToNow } from "date-fns";
import { GitForkIcon } from "lucide-react";
import { toast } from "sonner";

import { trpc } from "@/lib/trpc";
import { authClient } from "@/lib/auth-client";
import { track } from "@/lib/analytics";
import { saveLocalFlow } from "@/session";
import { useAppStore } from "@/stores/app";
import { FlowThumbnail } from "@/components/home/flow-thumbnail";
import {
  AuthorLink,
  BookmarkButton,
  type CommunityFlow,
} from "@/components/community/community-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/community/$flowId")({
  component: CommunityFlowPage,
});

function CommunityFlowPage() {
  const { flowId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setActiveFlowId = useAppStore((s) => s.setActiveFlowId);
  const { data: session } = authClient.useSession();
  const isSignedIn = !!session?.user;

  const { data, isLoading, error } = useQuery(
    trpc.community.get.queryOptions({ id: flowId })
  );
  const flow = data as CommunityFlow | undefined;

  const forkMutation = useMutation(
    trpc.community.fork.mutationOptions({
      onSuccess: (result) => {
        toast.success("Copied to your flows", { description: result.name });
        track("community_flow_forked", { flow: flowId });
        queryClient.invalidateQueries({ queryKey: trpc.flow.list.queryKey() });
        queryClient.invalidateQueries({ queryKey: trpc.community.pathKey() });
        setActiveFlowId(result.id);
        navigate({ to: "/flow/$flowId/graph", params: { flowId: result.id } });
      },
      onError: (err) => toast.error("Failed to copy flow", { description: err.message }),
    })
  );

  const handleFork = async () => {
    if (isSignedIn) {
      forkMutation.mutate({ id: flowId });
      return;
    }
    // Signed-out: same path templates take — into the device-local flow.
    if (!flow) return;
    await saveLocalFlow(flow.nodes, flow.edges);
    track("community_flow_forked", { flow: flowId, local: true });
    toast.success("Copied to your local flow");
    setActiveFlowId("local");
    navigate({ to: "/flow/$flowId/graph", params: { flowId: "local" } });
  };

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        This flow is not published (or no longer exists).
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto flex flex-col pb-16">
      <section className="container mx-auto px-4 md:px-8 pt-8 flex flex-col gap-6">
        {isLoading || !flow ? (
          <>
            <Skeleton className="aspect-video w-full rounded-xl" />
            <Skeleton className="h-8 w-64" />
          </>
        ) : (
          <>
            <div className="aspect-video max-h-[60vh] w-full rounded-xl border overflow-hidden bg-background shadow-sm">
              <ReactFlowProvider>
                <FlowThumbnail nodes={flow.nodes} edges={flow.edges} />
              </ReactFlowProvider>
            </div>

            <div className="flex flex-wrap items-start gap-4">
              <div className="mr-auto min-w-0">
                <h1 className="text-3xl font-semibold flex items-center gap-3">
                  <span
                    style={{ backgroundColor: flow.color ?? "var(--foreground)" }}
                    className="size-3 shrink-0 rounded-full"
                  />
                  {flow.name}
                </h1>
                <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                  <AuthorLink author={flow.author} />
                  {flow.publishedAt && (
                    <span>
                      Published{" "}
                      {formatDistanceToNow(flow.publishedAt, { addSuffix: true })}
                    </span>
                  )}
                  <span className="flex items-center gap-1 tabular-nums">
                    <GitForkIcon className="size-3.5" />
                    {flow.forkCount} {flow.forkCount === 1 ? "copy" : "copies"}
                  </span>
                </div>
                {flow.description && (
                  <p className="mt-4 text-muted-foreground max-w-prose">
                    {flow.description}
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                <BookmarkButton flow={flow} size="lg" />
                <Button size="lg" onClick={handleFork} disabled={forkMutation.isPending}>
                  <GitForkIcon className="size-4 mr-2" />
                  Copy to my flows
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
