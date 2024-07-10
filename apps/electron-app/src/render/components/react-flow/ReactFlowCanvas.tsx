import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import useStore, { AppState } from "../../store";
import { Button } from "./components/Button";
import { Led } from "./components/Led";
import { AutomaticSerialConnector } from "./panels/AutomaticSerialConnector";
import { CodeUploader } from "./panels/CodeUploader";
import { ComponentTabs } from "./panels/ComponentsTabs";

export function ReactFlowCanvas() {
  return (
    <ReactFlowProvider>
      <ReactFlowComponent />
    </ReactFlowProvider>
  );
}

const nodeTypes = {
  button: Button,
  led: Led,
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

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNode = {
        id: Math.random().toString(36).substring(2, 8),
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

      <Panel position="top-left">
        <ComponentTabs />
      </Panel>

      <Panel position="top-center">
        <AutomaticSerialConnector />
      </Panel>

      <Panel position="bottom-center">
        <CodeUploader />
      </Panel>
    </ReactFlow>
  );
}
