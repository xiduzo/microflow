import { ReactFlowCanvas } from "@/components/flow/react-flow-canvas";
import { authClient } from "@/lib/auth-client";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import { useFlowInit } from "@/stores/flow-store";
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
  const { initLocalFlow, destroy } = useFlowInit();

  // Initialize local flow when visiting this route
  useEffect(() => {
    setActiveFlowId("local");
    initLocalFlow();

    return () => {
      destroy();
    };
  }, [setActiveFlowId, initLocalFlow, destroy]);

  return (
    <ReactFlowProvider>
      <ReactFlowCanvas />
    </ReactFlowProvider>
  );
}
