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

export const baseEdgeConfig: Partial<Edge> = {
  style: { strokeWidth: 4 }
}

export const useNodesEdgesStore = create<AppState>((set, get) => ({
  nodes: [],
  edges: [],
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

export const nodesAndEdgesSelector = (state: AppState) => ({
  nodes: state.nodes,
  edges: state.edges,
})


export const outgoingEdgeIdSelector = (nodeId: string, handle: string) => (state: AppState) => state.edges.filter(edge => edge.source === nodeId && edge.sourceHandle === handle).map(edge => edge.id);
