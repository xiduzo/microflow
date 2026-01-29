import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CloudIcon, LayoutTemplateIcon, User2Icon } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { authClient } from "@/lib/auth-client";
import { FlowCard, FlowCardSkeleton } from "@/components/home/flow-card";
import { Button } from "@/components/ui/button";

import { CreateFlowDialog } from "@/components/flow/dialogs/create-flow-dialog";
import { ErrorState } from "@/components/states/error-state";
import { LoadingStateSkeleton } from "@/components/states/loading-state";
import { EmptyState } from "@/components/states/empty-state";
import { ButtonGroup } from "@/components/ui/button-group";

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
    <div className="h-full overflow-auto gap-8 flex flex-col pb-12">
      <header className="flex items-center justify-between sticky top-0 z-10 backdrop-blur-sm bg-background/50 p-8 rounded-t-xl">
        <section>
        </section>
        <section>
          <CreateFlowDialog />
        </section>
      </header>
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8 px-8">
        <FlowCard
          id="local"
          name="Local Flow"
          description="This flow is only available on this device"
          updatedAt={new Date().toISOString()}
          nodes={localFlowData.nodes}
          edges={localFlowData.edges}
          badges={[{
            label: "LOCAL",
            variant: "default"
          }]}
        />
        {isSignedIn && <CloudFlows />}
      </section>
      {!isSignedIn && <SignInNudge />}
    </div>
  );
}

function CloudFlows() {
  const { data, isLoading, error } = useQuery(trpc.flow.list.queryOptions());

  if (isLoading) return null
  if (error) return null

  const flows = [...(data?.owned ?? []), ...(data?.collaborated ?? [])];

  if (flows.length === 0) return null

  return (
    <>
      {flows.map((flow) => (
        <FlowCard
          key={flow.id}
          id={flow.id}
          name={flow.name}
          updatedAt={flow.updatedAt}
          nodes={flow.nodes}
          edges={flow.edges}
          badges={[
            {
              label: "role" in flow ? String(flow.role) : "owner",
              variant: "secondary",
            }
          ]}
        />
      ))}
    </>
  );
}

function SignInNudge() {
  return (
    <EmptyState
      title="Not signed in"
      description="Sign in to create multiple flows and collaborate with others"
      icon={User2Icon}
    >
      <Link to="/login">
        <Button>Sign in</Button>
      </Link>
    </EmptyState>
  );
}
