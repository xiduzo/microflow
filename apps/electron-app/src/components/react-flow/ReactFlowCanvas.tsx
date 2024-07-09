import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import useStore, { AppState } from "../../render/store";
import { Button } from "./components/Button";

export function ReactFlowCanvas() {
  return (
    <ReactFlowProvider>
      <ReactFlowComponent />
    </ReactFlowProvider>
  );
}

const nodeTypes = {
  button: Button,
};

const selector = (state: AppState) => ({
  nodes: state.nodes,
  edges: state.edges,
  onNodesChange: state.onNodesChange,
  onEdgesChange: state.onEdgesChange,
  onConnect: state.onConnect,
  addNode: state.addNode,
});

function ReactFlowComponent() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode } =
    useStore(useShallow(selector));
  const { screenToFlowPosition } = useReactFlow();

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData("application/reactflow");

      // check if the dropped element is valid
      if (typeof type === "undefined" || !type) {
        return;
      }

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNode = {
        id: Math.floor(Math.random() * 100000).toString(),
        type,
        position,
        data: { label: `${type} node` },
      };

      addNode(newNode);
    },
    [screenToFlowPosition],
  );

  return (
    <ReactFlow
      nodeTypes={nodeTypes}
      colorMode="dark"
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      <Controls />
      <MiniMap />
      <Background gap={32} />
    </ReactFlow>
  );
}
