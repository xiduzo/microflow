import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { AppState, useNodesEdgesStore } from "../../store";
import { Button, ButtonData } from "./components/Button";
import { Counter } from "./components/Counter";
import { Figma } from "./components/Figma";
import { IfElse } from "./components/IfElse";
import { Interval } from "./components/Interval";
import { Led, LedData } from "./components/Led";
import { ConnectionLine } from "./ConnectionLine";
import { ComponentTabs } from "./panels/ComponentsTabs";
import { SaveButton } from "./panels/SaveButton";
import { SerialConnectionStatus } from "./panels/SerialConnectionStatus";

const nodeTypes = {
  Button: Button,
  Led: Led,
  Counter: Counter,
  Figma: Figma,
  Interval: Interval,
  IfElse: IfElse,
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

export function ReactFlowComponent() {
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
        x: event.clientX - 120,
        y: event.clientY - 75,
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
          if (node.selected) return "#3b82f6";
          if (
            node.data.animated !== undefined &&
            node.data.value !== undefined &&
            node.data.value !== null
          )
            return "#f97316";
        }}
        nodeBorderRadius={12}
      />
      <Background gap={32} />

      <Panel position="top-left">
        <ComponentTabs />
      </Panel>

      <Panel position="top-center">
        <SerialConnectionStatus />
      </Panel>

      <Panel position="top-right">
        <SaveButton />
      </Panel>
    </ReactFlow>
  );
}
