import {
  Edge,
  MarkerType,
  Node,
  OnConnect,
  OnEdgesChange,
  OnNodesChange,
  addEdge, applyEdgeChanges, applyNodeChanges
} from '@xyflow/react';

import { create } from 'zustand';

export type AppState = {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  addNode: (node: Node) => void;
};

const initialNodes: Node[] = [
  {
    id: "1",
    type: "button",
    position: { x: 200, y: 200 },
    data: { label: "1" },
  },
  { id: "2", position: { x: 400, y: 400 }, data: { label: "2" } },
];


const initialEdges: Edge[] = [
  { id: "e1-2", source: "1", target: "2", markerEnd: { type: MarkerType.Arrow }, }
];


// this is our useStore hook that we can use in our components to get parts of the store and call actions
const useStore = create<AppState>((set, get) => ({
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
      edges: addEdge(connection, get().edges),
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

export default useStore;
