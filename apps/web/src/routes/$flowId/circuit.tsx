import { usePins } from "@/stores/board";
import { useFlowDocument, useFlowInit, useFlowStore } from "@/stores/flow-store";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import { useFlowNodes } from "@/hooks/use-flow-document";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { SchematicViewer } from "@tscircuit/schematic-viewer";
import { useMemo, useRef, useEffect, useCallback } from "react";
import { createCircuitJson, type TraceMetadata } from "@/lib/schematic/circuit-json";
import { authClient } from "@/lib/auth-client";
import { trpc } from "@/utils/trpc";
import { useQuery } from "@tanstack/react-query";
import { LoadingState } from "@/components/states/loading-state";
import { ErrorState } from "@/components/states/error-state";

/** Schematic color overrides using theme CSS vars inline – respects light/dark. */
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
  const containerRef = useRef<HTMLDivElement>(null);

  const { elements: circuitJson, traceMetadata } = useMemo(
    () => createCircuitJson(nodes, pins),
    [nodes, pins]
  );

  // Post-process SVG to add trace type classes for CSS styling
  const applyTraceClasses = useCallback((metadata: TraceMetadata[]) => {
    if (!containerRef.current) return;
    
    const svg = containerRef.current.querySelector("svg");
    console.log("scg",{svg})
    if (!svg) return;

    // Build a map of trace IDs to types
    const traceTypeMap = new Map<string, string>();
    for (const trace of metadata) {
      traceTypeMap.set(trace.schematicTraceId, trace.traceType);
      // Also map the source_trace_id variant
      const sourceId = trace.schematicTraceId.replace("schematic_trace_", "");
      traceTypeMap.set(sourceId, trace.traceType);
    }

    // Find trace elements by data attributes
    const traceGroups = svg.querySelectorAll('[data-circuit-json-type="schematic_trace"]');
    for (const group of traceGroups) {
      group.classList.add("trace");
      
      const traceId = group.getAttribute("data-schematic-trace-id") 
        || group.getAttribute("data-source-trace-id");
      
      const traceType = traceId ? traceTypeMap.get(traceId) : null;
      group.classList.add(traceType || "sig");
    }
  }, []);

  // Apply trace classes after render
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new MutationObserver(() => {
      applyTraceClasses(traceMetadata);
    });

    observer.observe(containerRef.current, {
      childList: true,
      subtree: true,
    });

    // Initial application with a small delay to ensure SVG is rendered
    const timeoutId = setTimeout(() => {
      applyTraceClasses(traceMetadata);
    }, 150);

    // Re-apply on window resize (SVG might re-render)
    const handleResize = () => {
      setTimeout(() => applyTraceClasses(traceMetadata), 100);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      observer.disconnect();
      clearTimeout(timeoutId);
      window.removeEventListener("resize", handleResize);
    };
  }, [traceMetadata, applyTraceClasses]);

  return (
    <div ref={containerRef} className="w-full h-full">
      <SchematicViewer
        // debugGrid
        circuitJson={circuitJson}
        colorOverrides={{
          schematic: SCHEMATIC_COLOR_OVERRIDES,
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
