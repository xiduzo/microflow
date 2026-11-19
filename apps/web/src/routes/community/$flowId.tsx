import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { formatDistanceToNow } from "date-fns";
import { GitForkIcon } from "lucide-react";
import { toast } from "sonner";

import { trpc } from "@/lib/trpc";
import { track } from "@/lib/analytics";
import { reportError } from "@/lib/report-error";
import { useOpenFlow } from "@/flows/use-open-flow";
import { FlowThumbnail } from "@/flows/flow-thumbnail";
import {
  AuthorLink,
  BookmarkButton,
  type CommunityFlow,
} from "@/community/community-card";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";

export const Route = createFileRoute("/community/$flowId")({
  component: CommunityFlowPage,
});

function CommunityFlowPage() {
  const { flowId } = Route.useParams();
  const queryClient = useQueryClient();
  const openFlow = useOpenFlow();

  const { data, isLoading, error } = useQuery(
    trpc.community.get.queryOptions({ id: flowId })
  );
  const flow = data as CommunityFlow | undefined;

  const forkMutation = useMutation(trpc.community.fork.mutationOptions());

  const handleFork = async () => {
    if (!flow) return;
    // Signed in, the server copies the published flow into the account. Signed
    // out, its content replaces the local flow, as a template does.
    const opened = await openFlow(
      { nodes: flow.nodes, edges: flow.edges },
      { account: () => forkMutation.mutateAsync({ id: flowId }) },
    );

    if (!opened.ok) {
      const description =
        opened.error instanceof Error ? opened.error.message : undefined;
      if (opened.where === "account") {
        toast.error("Failed to copy flow", { description });
      } else {
        reportError(opened.error, { source: "action", route: Route.id });
        toast.error("Couldn't copy to your local flow", { description });
      }
      return;
    }

    if (opened.where === "account") {
      toast.success("Copied to your flows", { description: opened.name });
      track("community_flow_forked", { flow: flowId });
      queryClient.invalidateQueries({ queryKey: trpc.flow.list.queryKey() });
      queryClient.invalidateQueries({ queryKey: trpc.community.pathKey() });
    } else {
      track("community_flow_forked", { flow: flowId, local: true });
      toast.success("Copied to your local flow");
    }
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
