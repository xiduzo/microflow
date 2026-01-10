import { createFileRoute } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { ReactFlowCanvas } from "@/components/flow/ReactFlowCanvas";

export const Route = createFileRoute("/flow")({
  component: FlowPage,
});

function FlowPage() {
  return (
    <div className="h-[calc(100vh-4rem)] w-full">
      <ReactFlowProvider>
        <ReactFlowCanvas />
      </ReactFlowProvider>
    </div>
  );
}
