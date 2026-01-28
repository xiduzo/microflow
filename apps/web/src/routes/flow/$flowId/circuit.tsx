import { usePins } from "@/stores/board";
import { useFlowDocument, useFlowInit, useFlowStore } from "@/stores/flow-store";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import { useFlowNodes } from "@/hooks/use-flow-document";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { SchematicViewer } from "@tscircuit/schematic-viewer";
import { useRef, useEffect, useState } from "react";
import { buildCircuitCode } from "@/lib/schematic/circuit-builder";
import { authClient } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";
import { useQuery } from "@tanstack/react-query";
import { LoadingState } from "@/components/states/loading-state";
import { ErrorState } from "@/components/states/error-state";
import { createCircuitWebWorker, type CircuitWebWorker } from "@tscircuit/eval";
import type { AnyCircuitElement } from "circuit-json";
import { EmptyState } from "@/components/states/empty-state";
import { useDebouncer } from "@tanstack/react-pacer";

/** Schematic color overrides using theme CSS vars */
const SCHEMATIC_COLOR_OVERRIDES = {
    // aux_items: "var(--foreground)",
    background: "transparent",
    brightened: "var(--accent)",
    // bus: "var(--foreground)",
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
    label_local: "var(--foreground)",
    // net_name: "var(--foreground)",
    // no_connect: "var(--foreground)",
    // note: "var(--muted-foreground)",
    // pin: "var(--foreground)",
    pin_name: "var(--foreground)", // Show pin names (labels like GND, VCC, SIG)
    pin_number: "var(--card-foreground)", // Pin numbers
    // reference: "var(--foreground)",
    // shadow: "var(--foreground)",
    // sheet: "var(--background)",
    // sheet_background: "var(--background)",
    // sheet_fields: "var(--foreground)",
    // sheet_filename: "var(--foreground)",
    // sheet_label: "var(--foreground)",
    // sheet_name: "var(--foreground)",
    // table: "var(--foreground)",
    // value: "var(--foreground)",
    // wire: "var(--foreground)",
    // wire_crossing: "var(--foreground)",
    // worksheet: "var(--background)",
} as const;


export const Route = createFileRoute("/flow/$flowId/circuit")({
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
    const flowDoc = useFlowDocument();

    const {
        data: flow,
        isLoading,
        error,
    } = useQuery({
        ...trpc.flow.get.queryOptions({ id: flowId }),
        enabled: flowId !== "local",
    });

    console.log({ flow })

    if (isLoading) return <LoadingState />;
    if (error) return <ErrorState title="Failed to load flow" error={error} />;
    if (!flowDoc) return <LoadingState />;

    return <CircuitViewer />;
}


function CircuitViewer() {
    const flowDoc = useFlowDocument();
    const nodes = useFlowNodes(flowDoc);
    const pins = usePins();
    const [{ isPending, error, data }, setState] = useState({ isPending: false, error: null as string | null, data: [] as AnyCircuitElement[] });
    const worker = useRef<CircuitWebWorker | null>(null);

    const debouncer = useDebouncer(async () => {
        if (!worker.current) {
            worker.current = await createCircuitWebWorker({
                projectConfig: {
                    pcbDisabled: true,
                    partsEngineDisabled: true,
                }
            });
        }
        const { code } = buildCircuitCode(nodes, pins)

        setState({ isPending: true, error: null, data: [] });

        // Create new runner for each render to avoid state issues
        console.log("Executing circuit code:", code);
        try {
            await worker.current?.execute(code);
            await worker.current?.renderUntilSettled();
            const json = await worker.current?.getCircuitJson();
            if (!json) return;
            console.log({ json });
            setState({ isPending: false, error: null, data: json });
        } catch (e) {
            console.error("Circuit render error:", e);
            setState({ isPending: false, error: e instanceof Error ? e.message : "Failed to render circuit", data: [] });
        }
    }, { wait: 1000 });

    console.log({ nodes })


    useEffect(() => {
        debouncer.maybeExecute();
    }, [nodes, pins, debouncer.maybeExecute]);


    if (debouncer.store.state.isPending || isPending) return <LoadingState title="Rendering circuit..." />;
    if (error) return <ErrorState title="Failed to render circuit" error={error} />;
    if (data.length === 0) return <EmptyState title="Add hardware components to your flow to see the circuit schematic" />;


    return (
        <div className="w-full h-full relative">
            {isPending && (
                <div className="absolute top-4 right-4 z-10">
                    <div className="bg-background/80 backdrop-blur px-3 py-1 rounded text-sm text-muted-foreground">
                        Updating...
                    </div>
                </div>
            )}
            <SchematicViewer
                circuitJson={data}
                editingEnabled={true}
                // onSchematicComponentClicked={console.log}
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
        </div>
    );
}
