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
import { toast } from "sonner";

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
    data: {
      instance: "Button",
      pin: 6,
      isPullup: false,
      isPulldown: false,
      holdtime: 500,
      invert: false,
      group: "hardware",
      tags: ["input", "digital"],
      icon: {},
      label: "Button",
      description: "Detect when a physical button is pressed or released",
    },
    id: "2ct8ux4s1d6",
    type: "Button",
    position: {
      x: 583.4133530864196,
      y: 1146.6887061728396,
    },
    measured: {
      width: 320,
      height: 220,
    },
    selected: false,
  },
  {
    data: {
      instance: "Led",
      pin: 13,
      group: "hardware",
      tags: ["output", "analog", "digital"],
      label: "LED",
      icon: {},
      description: "Turn a light on or off, or control its brightness",
    },
    id: "t4kj4nmdg4",
    type: "Led",
    position: {
      x: 1072.119750433015,
      y: 1184.3851130515895,
    },
    measured: {
      width: 320,
      height: 220,
    },
    selected: false,
  },
];

const initialEdges: Edge[] = [
  {
    source: "2ct8ux4s1d6",
    sourceHandle: "active",
    target: "t4kj4nmdg4",
    targetHandle: "turnOn",
    id: "qrcri1z",
    type: "animated",
  },
  {
    source: "2ct8ux4s1d6",
    sourceHandle: "inactive",
    target: "t4kj4nmdg4",
    targetHandle: "turnOff",
    id: "ml5fevk",
    type: "animated",
  },
];

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
    const selectedNodes = get().nodes.filter((node) => node.selected);
    if (!selectedNodes.length) return;
    set({ copiedNodes: selectedNodes });
    toast.success(`Copied ${get().copiedNodes.length} nodes`);
  },
  paste: (cursorCanvasPosition: XYPosition) => {
    const copiedNodes = get().copiedNodes;
    if (copiedNodes.length === 0) return;

    // Calculate the center (centroid) of all copied nodes, accounting for their dimensions
    const nodeCount = copiedNodes.length;
    const { sumX, sumY } = copiedNodes.reduce(
      (acc, node) => {
        const width = node.width ?? node.measured?.width ?? 0;
        const height = node.height ?? node.measured?.height ?? 0;
        return {
          sumX: acc.sumX + node.position.x + width / 2,
          sumY: acc.sumY + node.position.y + height / 2,
        };
      },
      { sumX: 0, sumY: 0 }
    );

    const centerX = sumX / nodeCount;
    const centerY = sumY / nodeCount;

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
