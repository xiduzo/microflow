import { authClient } from "@/lib/auth-client";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import {
    useFlowStore,
    useFlowDocument,
    useFlowInit,
} from "@/stores/flow-store";
import { useCircuitStore } from "@/stores/circuit-store";
import { useSyncProvider, type UseSyncProviderReturn } from "@/hooks/use-sync-provider";
import { useFlowNodes } from "@/hooks/use-flow-document";
import { usePins, type Pin } from "@/stores/board";
import { useDebouncer } from "@tanstack/react-pacer";
import { trpc } from "@/lib/trpc";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, createContext, useContext } from "react";
import { env } from "@microflow/env/web";
import { ErrorState } from "@/components/states/error-state";
import { LoadingState } from "@/components/states/loading-state";
import type { Node } from "@xyflow/react";

// Context to provide sync provider to child routes
const FlowSyncContext = createContext<UseSyncProviderReturn | null>(null);

/**
 * Listens to flow-store (nodes) and board store (pins) and triggers circuit build
 * in the circuit store. Runs when mounted under /flow/$flowId so the circuit
 * is built in the background before the user opens the circuit tab.
 */
function CircuitBuildListener() {
    const flowDoc = useFlowDocument();
    const nodes = useFlowNodes(flowDoc);
    const pins = usePins();
    const buildCircuit = useCircuitStore((s) => s.buildCircuit);

    const debouncer = useDebouncer(
        (nodes: Node[], pins: Pin[]) => {
            buildCircuit(nodes, pins);
        },
        { wait: 1000 },
    );

    useEffect(() => {
        if (!flowDoc) return;
        debouncer.maybeExecute(nodes, pins);
    }, [flowDoc, nodes, pins, debouncer.maybeExecute]);

    return null;
}

export function useFlowSync() {
    return useContext(FlowSyncContext);
}

export const Route = createFileRoute("/flow/$flowId")({
    component: RouteComponent,
    beforeLoad: async ({ params }) => {
        const session = await authClient.getSession();

        // For local flow, no auth required
        if (params.flowId === "local") {
            const { data: customerState } = await authClient.customer.state();
            return { session, customerState };
        }

        // For cloud flows, redirect to login if not authenticated
        if (!session.data) {
            throw redirect({
                to: "/login",
                search: { redirect: `/flow/${params.flowId}` },
            });
        }

        const { data: customerState } = await authClient.customer.state();
        return { session, customerState };
    },
});

function RouteComponent() {
    const { flowId } = Route.useParams();

    // Handle local flow
    if (flowId === "local") {
        return <LocalFlowLayout />;
    }

    // Handle cloud flow
    return <CloudFlowLayout />;
}

// No-op sync provider for local flows (no collaboration needed)
const localFlowSync: UseSyncProviderReturn = {
    state: "synced",
    isConnected: false,
    isSynced: true,
    error: null,
    users: [],
    localUser: null,
    updateCursor: () => { },
    updateSelectedNodes: () => { },
    reconnect: () => { },
    disconnect: () => { },
};

function LocalFlowLayout() {
    const setActiveFlowId = useActiveFlowStore((s) => s.setActiveFlowId);
    const { initLocalFlow } = useFlowInit();
    const flowDoc = useFlowDocument();

    // Initialize local flow when visiting this route
    useEffect(() => {
        setActiveFlowId("local");

        // Only initialize if not already initialized
        if (!flowDoc) {
            initLocalFlow();
        }

        // Don't destroy on unmount - local flow persists across navigation
        // It will be cleaned up when switching to a cloud flow or explicitly
    }, [setActiveFlowId, initLocalFlow, flowDoc]);

    // Provide mock sync context for local flow
    return (
        <FlowSyncContext.Provider value={localFlowSync}>
            <CircuitBuildListener />
            <Outlet />
        </FlowSyncContext.Provider>
    );
}

function CloudFlowLayout() {
    const { flowId } = Route.useParams();
    const { session } = Route.useRouteContext();
    const setActiveFlowId = useActiveFlowStore((s) => s.setActiveFlowId);
    const flowDoc = useFlowDocument();

    // Track initialization state to prevent double-init
    const initializedFlowId = useRef<string | null>(null);

    // Derive WebSocket URL from server URL
    const wsUrl = useMemo(() => {
        const serverUrl = new URL(env.VITE_SERVER_URL);
        serverUrl.protocol = serverUrl.protocol === "https:" ? "wss:" : "ws:";
        return serverUrl.origin;
    }, []);

    // Fetch flow metadata
    const {
        data: flow,
        isLoading,
        error,
    } = useQuery({
        ...trpc.flow.get.queryOptions({ id: flowId }),
        enabled: flowId !== "local",
    });

    // Set active flow ID when route loads
    useEffect(() => {
        setActiveFlowId(flowId);
        // Don't reset on cleanup - preserve active flow when navigating away
    }, [flowId, setActiveFlowId]);

    // Initialize the flow document with data from server
    useEffect(() => {
        if (!flow) return;

        // Prevent re-initialization for the same flow
        if (initializedFlowId.current === flowId) return;

        const initCloudFlow = useFlowStore.getState().initCloudFlow;

        if (flow.ydocBase64) {
            const ydocData = Uint8Array.from(atob(flow.ydocBase64), (c) =>
                c.charCodeAt(0)
            );
            initCloudFlow(flowId, ydocData, {
                name: flow.name,
            });
        } else {
            initCloudFlow(flowId, undefined, {
                name: flow.name,
            });
        }

        initializedFlowId.current = flowId;

        // Cleanup when leaving the route
        return () => {
            console.log(`[FLOW-LAYOUT] Leaving flow ${flowId}, cleaning up...`);
            initializedFlowId.current = null;
            useFlowStore.getState().destroy();
            useCircuitStore.getState().reset();
        };
    }, [flowId, flow?.ydocBase64]);

    // Fetch user profile settings
    const { data: profile } = useQuery({
        ...trpc.profile.get.queryOptions(),
        enabled: !!session.data,
    });

    // User info for sync provider - memoized to prevent reconnections
    const user = useMemo(
        () => ({
            id: session.data!.user.id,
            name: session.data!.user.name ?? "Anonymous",
            color: profile?.settings.collabColor,
            icon: profile?.settings.collabIcon,
        }),
        [
            session.data?.user.id,
            session.data?.user.name,
            profile?.settings.collabColor,
            profile?.settings.collabIcon,
        ]
    );

    // Connect to sync provider for real-time collaboration
    const sync = useSyncProvider({
        flowDoc,
        flowId,
        user,
        wsUrl,
        enabled: !!flowDoc && !!flow,
    });

    if (isLoading) return <LoadingState />;
    if (error) return <ErrorState title="Failed to load flow" error={error} />;

    // Provide sync through React context since TanStack Router context doesn't work well with hooks
    return (
        <FlowSyncContext.Provider value={sync}>
            <CircuitBuildListener />
            <Outlet />
        </FlowSyncContext.Provider>
    );
}
