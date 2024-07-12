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
  { id: "1", type: "Button", data: { pin: 8 }, position: { x: 600, y: 200 } },
  { id: "2", type: "Counter", data: { count: 5 }, position: { x: 600, y: 600 } },
  { id: "3", type: "Led", data: { pin: 13 }, position: { x: 900, y: 600 } },
];


const initialEdges: Edge[] = [
  { id: "1", source: "1", sourceHandle: "up", target: "2", targetHandle: "increment" },
  { id: "2", source: "1", sourceHandle: "up", target: "3", targetHandle: "toggle" },
];

const defaultEdgeStyle: Partial<Edge> = {
  style: { strokeWidth: 2 }
}

const useNodesEdgesStore = create<AppState>((set, get) => ({
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
      edges: addEdge(connection, get().edges).map(edge => ({ ...defaultEdgeStyle, ...edge })),
    });
  },
  setNodes: (nodes) => {
    set({ nodes });
  },
  setEdges: (edges) => {
    set({ edges });
  },
  addNode: (node) => {
    set({
      nodes: [...get().nodes, node],
    });
  }
}));

export const nodeSelector = <T extends Record<string, unknown> = {}>(nodeId: string) => (state: AppState<T>) => ({
  node: state.nodes.find((node) => node.id === nodeId),
});

export default useNodesEdgesStore;
