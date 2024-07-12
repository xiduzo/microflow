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
import useNodesEdgesStore, { AppState } from "../../store";
import { Button, ButtonData } from "./components/Button";
import { Counter } from "./components/Counter";
import { Led, LedData } from "./components/Led";
import { ConnectionLine } from "./ConnectionLine";
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
  Button: Button,
  Led: Led,
  Counter: Counter,
};

export type NodeType = keyof typeof nodeTypes;

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
    useNodesEdgesStore(useShallow(selector));
  const { screenToFlowPosition } = useReactFlow();

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData(
        "application/reactflow",
      ) as keyof typeof nodeTypes;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      let data: ButtonData | LedData;

      switch (type) {
        case "Button":
          data = { pin: 1 } satisfies ButtonData;
          break;
        case "Led":
          data = { pin: 13 } satisfies LedData;
          break;
      }

      const newNode = {
        id: Math.random().toString(36).substring(2, 8),
        type,
        position,
        data,
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
      connectionLineComponent={ConnectionLine}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      <Controls />
      <MiniMap
        nodeColor={(node) => {
          if (node.selected) return "#22c55e";
        }}
      />
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
