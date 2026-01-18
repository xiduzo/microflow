import { usePins } from "@/stores/board";
import { useFlowDocument, useFlowInit, useFlowStore } from "@/stores/flow-store";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import { useFlowNodes } from "@/hooks/use-flow-document";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { SchematicViewer } from "@tscircuit/schematic-viewer";
import { useMemo, useRef, useEffect } from "react";
import { createCircuitJson } from "@/lib/schematic/circuit-json";
import { authClient } from "@/lib/auth-client";
import { trpc } from "@/utils/trpc";
import { useQuery } from "@tanstack/react-query";
import { LoadingState } from "@/components/states/loading-state";
import { ErrorState } from "@/components/states/error-state";

export const Route = createFileRoute("/$flowId/circuit")({
  component: RouteComponent,
  beforeLoad: async ({ params }) => {
    const session = await authClient.getSession();

    // For local flow, no auth required
    if (params.flowId === "local") {
      return { session };
    }

    // For cloud flows, redirect to login if not authenticated
    if (!session.data) {
      throw redirect({
        to: "/login",
        search: { redirect: `/${params.flowId}/circuit` },
      });
    }

    return { session };
  },
});

function RouteComponent() {
  const { flowId } = Route.useParams();

  if (flowId === "local") {
    return <LocalCircuitComponent />;
  }

  return <CloudCircuitComponent />;
}

function LocalCircuitComponent() {
  const setActiveFlowId = useActiveFlowStore((s) => s.setActiveFlowId);
  const { initLocalFlow, destroy } = useFlowInit();
  const flowDoc = useFlowDocument();

  useEffect(() => {
    setActiveFlowId("local");
    initLocalFlow();

    return () => {
      destroy();
    };
  }, [setActiveFlowId, initLocalFlow, destroy]);

  if (!flowDoc) {
    return <LoadingState />;
  }

  return <CircuitViewer />;
}

function CloudCircuitComponent() {
  const { flowId } = Route.useParams();
  const setActiveFlowId = useActiveFlowStore((s) => s.setActiveFlowId);
  const flowDoc = useFlowDocument();
  const initializedFlowId = useRef<string | null>(null);

  const {
    data: flow,
    isLoading,
    error,
  } = useQuery({
    ...trpc.flow.get.queryOptions({ id: flowId }),
  });

  useEffect(() => {
    setActiveFlowId(flowId);
  }, [flowId, setActiveFlowId]);

  useEffect(() => {
    if (!flow) return;
    if (initializedFlowId.current === flowId) return;

    const initCloudFlow = useFlowStore.getState().initCloudFlow;

    if (flow.ydocBase64) {
      const ydocData = Uint8Array.from(atob(flow.ydocBase64), (c) =>
        c.charCodeAt(0)
      );
      initCloudFlow(flowId, ydocData, { name: flow.name });
    } else {
      initCloudFlow(flowId, undefined, { name: flow.name });
    }

    initializedFlowId.current = flowId;

    return () => {
      initializedFlowId.current = null;
      useFlowStore.getState().destroy();
    };
  }, [flowId, flow?.ydocBase64]);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState title="Failed to load flow" error={error} />;
  if (!flowDoc) return <LoadingState />;

  return <CircuitViewer />;
}

function CircuitViewer() {
  const flowDoc = useFlowDocument();
  const nodes = useFlowNodes(flowDoc);
  const pins = usePins();

  const circuitJson = useMemo(() => {
    console.log({nodes, pins})
    return createCircuitJson(nodes, pins);
  }, [nodes, pins]);

  return (
    <div className="w-full h-full">
      <SchematicViewer
        circuitJson={circuitJson}
        colorOverrides={{
          schematic: {
            // background: "var(--background)",
            // component_body: "var(--card-foreground)",
          },
        }}
        containerStyle={{
          width: "100%",
          height: "100%",
          borderRadius: "2rem",
        }}
      />
    </div>
  );
}
