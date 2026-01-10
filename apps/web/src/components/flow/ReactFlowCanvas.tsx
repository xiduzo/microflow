import { Background, Controls, MiniMap, ReactFlow } from "@xyflow/react";
import { useReactFlowCanvas } from "@/stores/react-flow";

import "@xyflow/react/dist/style.css";
import { NODE_TYPES } from "./nodes/_TYPES";

export function ReactFlowCanvas() {
  const store = useReactFlowCanvas();

  return (
    <ReactFlow
      {...store}
      colorMode="system"
      minZoom={0.1}
      maxZoom={2}
      nodeTypes={NODE_TYPES}
      fitView
      fitViewOptions={{ padding: 0.2 }}
    >
      <MiniMap nodeBorderRadius={8} pannable zoomable />
      <Background gap={20} />
      <Controls />
    </ReactFlow>
  );
}
