import type {
  Edge,
  Node,
  OnConnect,
  OnEdgesChange,
  OnNodesChange,
} from "@xyflow/react";
import { addEdge, applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import { useShallow } from "zustand/shallow";
import { create } from "zustand";

export type ReactFlowState = {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
};

// Generate unique IDs
const uid = () => Math.random().toString(36).substring(2, 9);

// Initial nodes for demo
const initialNodes: Node[] = [
  {
    id: "1",
    type: "default",
    position: { x: 100, y: 100 },
    data: { label: "Input Node" },
  },
  {
    id: "2",
    type: "default",
    position: { x: 400, y: 100 },
    data: { label: "Output Node" },
  },
];

const initialEdges: Edge[] = [{ id: "e1-2", source: "1", target: "2" }];

export const useReactFlowStore = create<ReactFlowState>()((set, get) => ({
  nodes: initialNodes,
  edges: initialEdges,

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  onConnect: (connection) => {
    set({
      edges: addEdge(
        { ...connection, id: uid(), type: "animated" },
        get().edges
      ),
    });
  },

  setNodes: (nodes) => {
    set({ nodes });
  },

  setEdges: (edges) => {
    set({ edges });
  },
}));

export function useReactFlowCanvas() {
  return useReactFlowStore(
    useShallow((state) => ({
      nodes: state.nodes,
      edges: state.edges,
      onNodesChange: state.onNodesChange,
      onEdgesChange: state.onEdgesChange,
      onConnect: state.onConnect,
    }))
  );
}

export function useNodesChange() {
  return useReactFlowStore(useShallow((state) => state.onNodesChange));
}

export function useEdgesChange() {
  return useReactFlowStore(useShallow((state) => state.onEdgesChange));
}
