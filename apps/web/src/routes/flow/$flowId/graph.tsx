import { ReactFlowCanvas } from "@/components/flow/react-flow-canvas";
import { useCollabPresence, type UseSyncProviderReturn } from "@/hooks/use-sync-provider";
import { createFileRoute } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { useFlowSync } from "../$flowId";
import { LoadingState } from "@/components/states/loading-state";

export const Route = createFileRoute("/flow/$flowId/graph")({
    component: RouteComponent,
});

function RouteComponent() {
    const sync = useFlowSync();

    if (!sync) return <LoadingState />

    return <ComponentWithSync sync={sync} />
}

function ComponentWithSync(props: { sync: UseSyncProviderReturn }) {
    const { sync } = props;
    const presence = useCollabPresence(sync)

    return (
        <ReactFlowProvider>
            <ReactFlowCanvas
                updateCursor={sync.updateCursor}
                otherUsers={presence.otherUsers}
            />
        </ReactFlowProvider>
    );
}