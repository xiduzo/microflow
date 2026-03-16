import { useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { User2Icon, HardDriveDownloadIcon, Plus } from "lucide-react";
import { toast } from "sonner";

import { trpc } from "@/lib/trpc";
import { authClient } from "@/lib/auth-client";
import { FlowCard, FlowCardSkeleton } from "@/components/home/flow-card";
import { Button } from "@/components/ui/button";

import { CreateFlowDialog } from "@/components/flow/dialogs/create-flow-dialog";
import { EmptyState } from "@/components/states/empty-state";
import { compareDesc } from "date-fns";
import {
  exportFlowData,
  useOverviewImport,
  LOCAL_FLOW_STORAGE_KEY,
  type FlowExportData,
} from "@/hooks/use-flow-import-export";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import { FLOW_COLORS } from "@/lib/flow-colors";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const { data: session } = authClient.useSession();
  const isSignedIn = !!session?.user;
  const triggerImport = useOverviewImport();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const setActiveFlowId = useActiveFlowStore((s) => s.setActiveFlowId);

  const createFromImportMutation = useMutation(
    trpc.flow.createFromImport.mutationOptions({
      onSuccess: (result) => {
        toast.success("Flow imported", {
          description: `${result.name} has been created`,
        });
        queryClient.invalidateQueries({ queryKey: trpc.flow.list.queryKey() });
        setActiveFlowId(result.id);
        navigate({ to: "/flow/$flowId/graph", params: { flowId: result.id } });
      },
      onError: (error) => {
        toast.error("Failed to import flow", {
          description: error.message,
        });
      },
    })
  );

  const handleImport = useCallback(
    async (data: FlowExportData) => {
      const name = data.meta?.name ?? "Imported flow";
      const color = FLOW_COLORS[Math.floor(Math.random() * FLOW_COLORS.length)];

      if (isSignedIn) {
        createFromImportMutation.mutate({
          name,
          color,
          nodes: data.data.nodes,
          edges: data.data.edges,
        });
      } else {
        const payload = { nodes: data.data.nodes, edges: data.data.edges };
        localStorage.setItem(LOCAL_FLOW_STORAGE_KEY, JSON.stringify(payload));
        setActiveFlowId("local");
        toast.success("Flow imported", {
          description: `${data.data.nodes.length} nodes, ${data.data.edges.length} edges`,
        });
        navigate({ to: "/flow/$flowId/graph", params: { flowId: "local" } });
      }
    },
    [isSignedIn, createFromImportMutation, setActiveFlowId, navigate]
  );

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
    <div className="h-full overflow-auto flex flex-col pb-16">
      <section className="container mx-auto px-4 md:px-8">
        <div className="flex flex-col gap-10 pt-8">
          <section>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-xl font-semibold">My Flows</h2>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => triggerImport(handleImport)}
                >
                  <HardDriveDownloadIcon className="size-4 mr-2" />
                  Import
                </Button>
                <CreateFlowDialog trigger={<Button size="sm"><Plus className="size-4 mr-2" />New Flow</Button>} />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
              <FlowCard
                id="local"
                name="Local Flow"
                description="This flow is only available on this device"
                updatedAt={new Date().toISOString()}
                nodes={localFlowData.nodes}
                edges={localFlowData.edges}
                badges={[{ label: "LOCAL", variant: "default" }]}
                onExport={() => {
                  exportFlowData(
                    { name: "Local Flow", updatedAt: Date.now() },
                    { nodes: localFlowData.nodes, edges: localFlowData.edges }
                  );
                  toast.success("Flow exported");
                }}
              />
              {isSignedIn && <CloudFlows />}
            </div>
          </section>
        </div>
      </section>
      {!isSignedIn && <SignInNudge />}
    </div>
  );
}

function CloudFlows() {
  const { data, isLoading, error } = useQuery(trpc.flow.list.queryOptions());

  if (isLoading) return (
    <>
      <FlowCardSkeleton />
      <FlowCardSkeleton />
      <FlowCardSkeleton />
    </>
  );
  if (error) return null;

  const flows = [...(data?.owned ?? []), ...(data?.collaborated ?? [])].sort((a,b) => compareDesc(a.updatedAt, b.updatedAt));

  if (flows.length === 0) return null;

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
            },
          ]}
          onExport={() => {
            exportFlowData(
              {
                name: flow.name,
                updatedAt: new Date(flow.updatedAt).getTime(),
              },
              { nodes: flow.nodes, edges: flow.edges }
            );
            toast.success("Flow exported");
          }}
          settingsFlowId={flow.id}
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
