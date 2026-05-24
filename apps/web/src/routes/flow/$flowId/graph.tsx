import { ReactFlowCanvas } from "@/components/flow/react-flow-canvas";
import { createFileRoute } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";

export const Route = createFileRoute("/flow/$flowId/graph")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <ReactFlowProvider>
      <ReactFlowCanvas />
    </ReactFlowProvider>
  );
}
