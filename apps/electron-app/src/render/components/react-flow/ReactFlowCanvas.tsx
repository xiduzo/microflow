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
import { ConnectionLine } from "./ConnectionLine";
import { Button, ButtonData } from "./nodes/Button";
import { Counter, CounterData } from "./nodes/Counter";
import { Figma, FigmaData } from "./nodes/Figma";
import { IfElse, IfElseData } from "./nodes/IfElse";
import { Interval, IntervalData } from "./nodes/Interval";
import { Led, LedData } from "./nodes/Led";
import { Mqtt, MqttData } from "./nodes/Mqtt";
import { BaseNode } from "./nodes/Node";
import { defaultSong, Piezo, PiezoData } from "./nodes/Piezo";
import { RangeMap, RangeMapData } from "./nodes/RangeMap";
import { Sensor, SensorData } from "./nodes/Sensor";
import { Servo, ServoData } from "./nodes/Servo";
import { ComponentTabs } from "./panels/ComponentsTabs";
import { MenuButton } from "./panels/MenuButton";
import { SerialConnectionStatus } from "./panels/SerialConnectionStatus";

const nodeTypes = {
  Button: Button,
  Led: Led,
  Counter: Counter,
  Figma: Figma,
  Interval: Interval,
  IfElse: IfElse,
  RangeMap: RangeMap,
  Mqtt: Mqtt,
  Sensor: Sensor,
  Servo: Servo,
  Piezo: Piezo
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
  const { screenToFlowPosition, updateNodeData } = useReactFlow<BaseNode>();

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

      let data: Record<string, any> = {};

      switch (type) {
        case "Button":
          data = { pin: 1, label: "Button" } satisfies ButtonData & { label: string };
          break;
        case "Counter":
          data = { label: 'Counter' } satisfies CounterData & { label: string };
          break;
        case "Figma":
          data = { label: "Figma variable" } satisfies FigmaData & { label: string };
          break;
        case "IfElse":
          data = { validator: 'boolean', subValidator: "", validatorArgs: [], label: "If / Else" } satisfies IfElseData & { label: string };
          break;
        case "Interval":
          data = { interval: 500, label: "Interval" } satisfies IntervalData & { label: string };
          break;
        case "Led":
          data = { pin: 13, label: "LED" } satisfies LedData & { label: string };
          break;
        case "RangeMap":
          data = { from: [0, 1023], to: [0, 1023], label: "Map" } satisfies RangeMapData & { label: string };
          break;
        case "Mqtt":
          data = { topic: "", direction: "publish", label: "MQTT" } satisfies MqttData & { label: string };
          break;
        case "Sensor":
          data = { pin: "A0", label: "Sensor" } satisfies SensorData & { label: string };
          break;
        case "Servo":
          data = { pin: 9, range: [0, 180], type: "standard", center: false, label: "Servo" } satisfies ServoData & { label: string };
          break;
        case "Piezo":
          data = { pin: 3, label: "Piezo", type: "song", tempo: 100, song: defaultSong } satisfies PiezoData & { label: string };
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
      // @ts-expect-error
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
      minZoom={0.2}
      maxZoom={1.25}
      onNodeDoubleClick={(_event, node) => {
        updateNodeData(node.id, { settingsOpen: true });
      }}
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
        <MenuButton />
      </Panel>

      <Panel
        position="bottom-center"
        className="text-gray-50/20 bg-neutral-950/5 backdrop-blur-sm rounded-md p-2"
      >
        <a href="https://www.sanderboer.nl" target="_blank" className="py-2 text-center text-muted-foreground transition-all hover:opacity-100 hover:underline">
          Made with ♥ by Xiduzo
        </a>
      </Panel>
    </ReactFlow >
  );
}
