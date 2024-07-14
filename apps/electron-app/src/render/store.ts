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
  style: { strokeWidth: 4, stroke: '#4b5563' }
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
      edges: applyEdgeChanges(changes, get().edges).map(edge => {
        if (edge.selected) {
          edge.style = {
            ...baseEdgeConfig.style,
            stroke: '#22c55e',
          }
        } else if (edge.animated) {
          edge.style = {
            ...baseEdgeConfig.style,
            stroke: '#eab308',
          }
        } else {
          edge.style = baseEdgeConfig.style
        }

        return edge
      })
    });
  },
  onConnect: (connection) => {
    const currentEdges = get().edges;
    const newEdges = addEdge(connection, currentEdges);

    set({
      edges: newEdges.map(edge => ({ ...baseEdgeConfig, ...edge })),
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

export const nodesAndEdgesCountsSelector = (state: AppState) => ({
  nodesCount: state.nodes.length,
  edgesCount: state.edges.length,
})

export const outgoingEdgeIdSelector = (nodeId: string, handle: string) => (state: AppState) => state.edges.filter(edge => edge.source === nodeId && edge.sourceHandle === handle).map(edge => edge.id);
