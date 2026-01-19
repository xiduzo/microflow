import { usePins } from "@/stores/board";
import { useFlowDocument, useFlowInit, useFlowStore } from "@/stores/flow-store";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import { useFlowNodes } from "@/hooks/use-flow-document";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { SchematicViewer } from "@tscircuit/schematic-viewer";
import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { buildCircuitCode } from "@/lib/schematic/circuit-builder";
import { authClient } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";
import { useQuery } from "@tanstack/react-query";
import { LoadingState } from "@/components/states/loading-state";
import { ErrorState } from "@/components/states/error-state";
import { CircuitRunner } from "@tscircuit/eval";
import type { CircuitJson } from "circuit-json";

/** Schematic color overrides using theme CSS vars */
const SCHEMATIC_COLOR_OVERRIDES = {
  // aux_items: "var(--muted-foreground)",
  background: "transparent",
  brightened: "var(--accent)",
  // bus: "var(--foreground)",s
  // bus_junction: "var(--foreground)",
  component_body: "var(--card)",
  component_outline: "var(--card-foreground)",
  // cursor: "var(--primary)",
  // erc_error: "var(--destructive)",
  // erc_warning: "var(--chart-2)",
  // fields: "var(--foreground)",
  // grid: "var(--muted-foreground)",
  // grid_axes: "var(--muted-foreground)",
  // hidden: "var(--muted-foreground)",
  // junction: "var(--foreground)",
  label_global: "var(--muted-foreground)",
  label_background: "var(--muted)",
  // label_hier: "var(--foreground)",
  // label_local: "var(--card-foreground)",
  // net_name: "var(--foreground)",
  // no_connect: "var(--foreground)",
  // note: "var(--muted-foreground)",
  // pin: "var(--foreground)",
  pin_name: "var(--foreground)", // Show pin names (labels like GND, VCC, SIG)
  pin_number: "var(--card-foreground)", // Pin numbers
  // reference: "var(--foreground)",
  // shadow: "var(--border)",
  // sheet: "var(--background)",
  // sheet_background: "var(--background)",
  // sheet_fields: "var(--muted-foreground)",
  // sheet_filename: "var(--muted-foreground)",
  // sheet_label: "var(--card-foreground)",
  // sheet_name: "var(--card-foreground)",
  // table: "var(--muted-foreground)",
  // value: "var(--card-foreground)",
  wire: "var(--foreground)",
  // wire_crossing: "var(--foreground)",
  // worksheet: "var(--background)",
} as const;


export const Route = createFileRoute("/$flowId/circuit")({
  component: RouteComponent,
  beforeLoad: async ({ params }) => {
    const session = await authClient.getSession();

    if (params.flowId === "local") {
      return { session };
    }

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
  const [circuitJson, setCircuitJson] = useState<CircuitJson>([]);
  const [error, setError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const runnerRef = useRef<CircuitRunner | null>(null);

  // Build circuit code from nodes
  const { code, componentCount } = useMemo(
    () => {
      const _code = buildCircuitCode(nodes, pins)
      console.log(nodes, pins, _code)
      return _code
    },
    [nodes, pins]
  );

  // Render circuit using CircuitRunner
  const renderCircuit = useCallback(async (circuitCode: string) => {
    if (isRendering) return;

    setIsRendering(true);
    setError(null);

    try {
      // Create new runner for each render to avoid state issues
      const runner = new CircuitRunner();
      runnerRef.current = runner;

      console.log("Executing circuit code:", circuitCode);
      await runner.execute(circuitCode);
      await runner.renderUntilSettled();

      const json = await runner.getCircuitJson();
      console.log("Circuit JSON result:", json);

      // Only update if we got valid results
      if (json && Array.isArray(json) && json.length > 0) {
        setCircuitJson(json);
      } else {
        console.warn("Empty circuit JSON returned");
        setError("Circuit rendered but produced no elements");
      }
    } catch (e) {
      console.error("Circuit render error:", e);
      setError(e instanceof Error ? e.message : "Failed to render circuit");
    } finally {
      setIsRendering(false);
    }
  }, [isRendering]);

  // Re-render when code changes
  useEffect(() => {
    if (code && componentCount > 0) {
      // Small delay to avoid rapid re-renders
      const timeoutId = setTimeout(() => {
        renderCircuit(code);
      }, 100);
      return () => clearTimeout(timeoutId);
    }
  }, [code, componentCount]);

  if (isRendering && circuitJson.length === 0) {
    return <LoadingState />;
  }

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div className="text-center p-8">
          <p className="text-destructive mb-2">Circuit render error</p>
          <p className="text-muted-foreground text-sm">{error}</p>
          <pre className="mt-4 p-4 bg-muted rounded text-xs text-left overflow-auto max-w-2xl max-h-64">
            {code}
          </pre>
        </div>
      </div>
    );
  }

  if (componentCount === 0 || circuitJson.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <p className="text-muted-foreground">
          {componentCount === 0
            ? "Add hardware components to your flow to see the circuit schematic"
            : "Rendering circuit..."}
        </p>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative">
      {isRendering && (
        <div className="absolute top-4 right-4 z-10">
          <div className="bg-background/80 backdrop-blur px-3 py-1 rounded text-sm text-muted-foreground">
            Updating...
          </div>
        </div>
      )}
      {circuitJson.length > 0 && (
        <SchematicViewer
          circuitJson={circuitJson}
          // debug
          // debugGrid
          colorOverrides={{
            schematic: SCHEMATIC_COLOR_OVERRIDES,
          }}
          containerStyle={{
            width: "100%",
            height: "100%",
            borderRadius: "2rem",
          }}
        />
      )}
    </div>
  );
}
