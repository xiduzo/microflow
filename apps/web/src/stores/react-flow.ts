import type {
  Edge,
  Node,
  OnConnect,
  OnEdgesChange,
  OnNodesChange,
  Position,
  XYPosition,
} from "@xyflow/react";
import { addEdge, applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import { useShallow } from "zustand/shallow";
import { create } from "zustand";

export type ReactFlowState = {
  nodes: Node[];
  edges: Edge[];
  copiedNodes: Node[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  selectAll: () => void;
  copy: () => void;
  paste: (cursorCanvasPosition: XYPosition) => void;
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
  copiedNodes: [],

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

  selectAll: () => {
    set({
      nodes: get().nodes.map((node) => ({ ...node, selected: true })),
      edges: get().edges.map((edge) => ({ ...edge, selected: true })),
    });
  },
  copy: () => {
    set({ copiedNodes: get().nodes.filter((node) => node.selected) });
  },
  paste: (cursorCanvasPosition: XYPosition) => {
    const copiedNodes = get().copiedNodes;
    if (copiedNodes.length === 0) return;

    // Calculate the center (centroid) of all copied nodes, accounting for their dimensions
    const nodeCenters = copiedNodes.map((node) => {
      const width = node.width ?? node.measured?.width ?? 0;
      const height = node.height ?? node.measured?.height ?? 0;
      return {
        centerX: node.position.x + width / 2,
        centerY: node.position.y + height / 2,
      };
    });

    const centerX =
      nodeCenters.reduce((sum, center) => sum + center.centerX, 0) /
      nodeCenters.length;
    const centerY =
      nodeCenters.reduce((sum, center) => sum + center.centerY, 0) /
      nodeCenters.length;

    // Calculate the offset from the center to the cursor position
    const offsetX = cursorCanvasPosition.x - centerX;
    const offsetY = cursorCanvasPosition.y - centerY;

    set({
      nodes: [
        ...copiedNodes.map((node) => {
          return {
            ...node,
            position: {
              x: node.position.x + offsetX,
              y: node.position.y + offsetY,
            },
            selected: false,
            id: uid(),
          };
        }),
        ...get().nodes,
      ],
    });
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

export function useReactFlowStoreHelpers() {
  return useReactFlowStore(
    useShallow((state) => ({
      selectAll: state.selectAll,
      copy: state.copy,
      paste: state.paste,
    }))
  );
}

export function useNodesChange() {
  return useReactFlowStore(useShallow((state) => state.onNodesChange));
}

export function useEdgesChange() {
  return useReactFlowStore(useShallow((state) => state.onEdgesChange));
}
