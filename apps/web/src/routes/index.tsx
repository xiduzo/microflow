import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { WaypointsIcon, CloudIcon, LogInIcon } from "lucide-react";

import { trpc } from "@/utils/trpc";
import { authClient } from "@/lib/auth-client";
import { FlowCard, FlowCardSkeleton } from "@/components/home/flow-card";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import { CreateFlowDialog } from "@/components/flow/create-flow-dialog";

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
              All your flows in one place
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
              isOwner
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

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <FlowCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Empty className="border rounded-xl py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WaypointsIcon className="size-4" />
          </EmptyMedia>
          <EmptyTitle>Failed to load flows</EmptyTitle>
          <EmptyDescription>{error.message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const flows = [...(data?.owned ?? []), ...(data?.collaborated ?? [])];

  if (!flows || flows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WaypointsIcon className="size-4" />
          </EmptyMedia>
          <EmptyTitle>No cloud flows yet</EmptyTitle>
          <EmptyDescription>
            Create your first cloud flow to sync across devices
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <CreateFlowDialog />
        </EmptyContent>
      </Empty>
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
          isOwner={!("role" in flow)}
          role={"role" in flow ? flow.role : undefined}
        />
      ))}
    </div>
  );
}

function SignInNudge() {
  return (
    <Empty className="border border-dashed rounded-xl py-12 bg-muted/10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CloudIcon className="size-4" />
        </EmptyMedia>
        <EmptyTitle>Sign in for cloud sync</EmptyTitle>
        <EmptyDescription>
          Get cloud backup, multiple flows, and real-time collaboration
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link to="/login">
          <Button>
            <LogInIcon className="size-4 mr-2" />
            Sign in
          </Button>
        </Link>
      </EmptyContent>
    </Empty>
  );
}
