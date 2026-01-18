import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CloudIcon, LogInIcon, User2Icon } from "lucide-react";

import { trpc } from "@/utils/trpc";
import { authClient } from "@/lib/auth-client";
import { FlowCard, FlowCardSkeleton } from "@/components/home/flow-card";
import { Button } from "@/components/ui/button";

import { CreateFlowDialog } from "@/components/flow/dialogs/create-flow-dialog";
import { ErrorState } from "@/components/states/error-state";
import { LoadingStateSkeleton } from "@/components/states/loading-state";
import { EmptyState } from "@/components/states/empty-state";

const LOCAL_FLOW_STORAGE_KEY = "microflow-local-flow";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const { data: session } = authClient.useSession();
  const isSignedIn = !!session?.user;

  // Read local flow directly from localStorage to avoid showing the last visited flow
  const localFlowData = useMemo(() => {
    try {
      const stored = localStorage.getItem(LOCAL_FLOW_STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        return { nodes: data.nodes ?? [], edges: data.edges ?? [] };
      }
    } catch (e) {
      console.error("[HOME] Failed to load local flow:", e);
    }
    return { nodes: [], edges: [] };
  }, []);

  return (
    <div className="h-full overflow-auto">
      <div className="container max-w-6xl mx-auto py-8 px-4 space-y-8">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Your Flows</h1>
            <p className="text-muted-foreground text-sm">
              Manage your local flow and sync to the cloud for collaboration
            </p>
          </div>
          {isSignedIn && <CreateFlowDialog />}
        </header>

        {/* Local section - always visible */}
        <section>
          <h2 className="text-sm font-medium text-muted-foreground mb-3">
            Local
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            <FlowCard
              id="local"
              name="Local Flow"
              updatedAt={new Date().toISOString()}
              nodes={localFlowData.nodes}
              edges={localFlowData.edges}
              isLocal
            />
          </div>
        </section>

        {/* Cloud section - always visible, content changes based on auth */}
        <section>
          <h2 className="text-sm font-medium text-muted-foreground mb-3">
            Cloud
          </h2>
          {isSignedIn ? <CloudFlows /> : <SignInNudge />}
        </section>
      </div>
    </div>
  );
}

function CloudFlows() {
  const { data, isLoading, error } = useQuery(trpc.flow.list.queryOptions());

  if (isLoading)
    return <LoadingStateSkeleton skeleton={<FlowCardSkeleton />} />;

  if (error) return <ErrorState title="Failed to load flows" error={error} />;

  const flows = [...(data?.owned ?? []), ...(data?.collaborated ?? [])];

  if (!flows || flows.length === 0) {
    return (
      <EmptyState title="No flows found" icon={CloudIcon}>
        <CreateFlowDialog />
      </EmptyState>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {flows.map((flow) => (
        <FlowCard
          key={flow.id}
          id={flow.id}
          name={flow.name}
          description={"description" in flow ? flow.description : undefined}
          updatedAt={flow.updatedAt}
          nodes={flow.nodes}
          edges={flow.edges}
          role={"role" in flow ? String(flow.role) : "owner"}
        />
      ))}
    </div>
  );
}

function SignInNudge() {
  return (
    <EmptyState
      title="Not signed in"
      description="Sign in to sync your flows across devices and collaborate with others"
      icon={User2Icon}
    >
      <Link to="/login">
        <Button>Sign in</Button>
      </Link>
    </EmptyState>
  );
}
