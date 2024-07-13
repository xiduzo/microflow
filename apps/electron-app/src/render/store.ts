import {
  Edge,
  Node,
  OnConnect,
  OnEdgesChange,
  OnNodesChange,
  addEdge, applyEdgeChanges, applyNodeChanges
} from '@xyflow/react';

import { create } from 'zustand';

export type AppState<NodeData extends Record<string, unknown> = {}> = {
  nodes: Node<NodeData>[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node<NodeData>>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: (nodes: Node<NodeData>[]) => void;
  setEdges: (edges: Edge[]) => void;
  addNode: (node: Node<NodeData>) => void;
};

const initialNodes: Node[] = [
  { id: "button_1", type: "Button", data: { pin: 8 }, position: { x: 600, y: 200 } },
  { id: "counter_1", type: "Counter", data: { count: 5 }, position: { x: 600, y: 600 } },
  { id: "led_1", type: "Led", data: { pin: 13 }, position: { x: 900, y: 600 } },
];

export const baseEdgeConfig: Partial<Edge> = {
  style: { strokeWidth: 4, stroke: "#404040" }
}

const initialEdges: Edge[] = [
  { id: "1", source: "button_1", sourceHandle: "up", target: "counter_1", targetHandle: "increment", ...baseEdgeConfig },
  { id: "2", source: "button_1", sourceHandle: "up", target: "led_1", targetHandle: "toggle", ...baseEdgeConfig },
];

export const useNodesEdgesStore = create<AppState>((set, get) => ({
  nodes: initialNodes,
  edges: initialEdges,
  onNodesChange: (changes) => {
    set({
      nodes: applyNodeChanges(changes, get().nodes),
    });
  },
  onEdgesChange: (changes) => {
    set({
      edges: applyEdgeChanges(changes, get().edges),
    });
  },
  onConnect: (connection) => {
    set({
      edges: addEdge(connection, get().edges).map(edge => ({ ...baseEdgeConfig, ...edge })),
    });
  },
  setNodes: (nodes) => {
    set({ nodes });
  },
  setEdges: (edges) => {
    set({ edges });
  },
  addNode: (node) => {
    if (!node.data) node.data = {}

    set({
      nodes: [...get().nodes, node],
    });
  }
}));

export const nodeSelector = <T extends Record<string, unknown> = {}>(nodeId: string) => (state: AppState<T>) => ({
  node: state.nodes.find((node) => node.id === nodeId),
});

export const edgeSelector = (edgeId: string) => (state: AppState) => ({
  edge: state.edges.find((edge) => edge.id === edgeId),
})

export const incommingEdgeSelector = (nodeId: string, handle: string) => (state: AppState) => ({
  incommingEdges: state.edges.filter((edge) => edge.target === nodeId && edge.targetHandle === handle),
  outgoingEdges: state.edges.filter((edge) => edge.source === nodeId && edge.sourceHandle === handle),
})

export const nodesAndEdgesSelector = (state: AppState) => ({
  nodes: state.nodes,
  edges: state.edges,
})
