import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { trpc } from "@/utils/trpc";
import { ReactFlowProvider } from "@xyflow/react";
import { ReactFlowCanvas } from "@/components/flow/ReactFlowCanvas";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const healthCheck = useQuery(trpc.healthCheck.queryOptions());

  console.log(healthCheck);

  return (
   <div>hi there</div>
  );
}
