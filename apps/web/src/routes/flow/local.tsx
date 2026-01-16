import { ReactFlowCanvas } from "@/components/flow/ReactFlowCanvas";
import { authClient } from "@/lib/auth-client";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import { useFlowLoader } from "@/stores/flow-store";
import { createFileRoute } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect } from "react";

export const Route = createFileRoute("/flow/local")({
  component: LocalFlowComponent,
  beforeLoad: async () => {
    const session = await authClient.getSession();
    const { data: customerState } = await authClient.customer.state();
    return { session, customerState };
  },
});

function LocalFlowComponent() {
  const setActiveFlowId = useActiveFlowStore((s) => s.setActiveFlowId);
  const { loadLocalFlow } = useFlowLoader();

  // Load local flow data and set active flow ID when visiting this route
  useEffect(() => {
    setActiveFlowId("local");
    loadLocalFlow();
  }, [setActiveFlowId, loadLocalFlow]);

  return (
    <ReactFlowProvider>
      <ReactFlowCanvas />
    </ReactFlowProvider>
  );
}
