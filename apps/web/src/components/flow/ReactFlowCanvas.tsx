import { Background, Controls, MiniMap, ReactFlow } from "@xyflow/react";
import { useReactFlowCanvas } from "@/stores/react-flow";

import "@xyflow/react/dist/style.css";

export function ReactFlowCanvas() {
  const store = useReactFlowCanvas();

  return (
    <ReactFlow
      {...store}
      colorMode="system"
      minZoom={0.1}
      maxZoom={2}
      fitView
      fitViewOptions={{ padding: 0.2 }}
    >
      <MiniMap nodeBorderRadius={8} pannable zoomable />
      <Background gap={20} />
      <Controls />
    </ReactFlow>
  );
}
