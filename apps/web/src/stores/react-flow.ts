import type {
  Edge,
  Node,
  OnConnect,
  OnEdgesChange,
  OnNodesChange,
  XYPosition,
} from "@xyflow/react";
import { addEdge, applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import { useShallow } from "zustand/shallow";
import { create } from "zustand";
import { toast } from "sonner";
import { Debouncer } from "@tanstack/react-pacer";
import { isDesktop } from "@/utils/platform";
import { invokeCommand } from "@/utils/ipc";

export type ReactFlowState = {
  nodes: Node[];
  edges: Edge[];
  copiedNodes: Node[];
  updateFlow: () => void;
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
  "data": {
    "instance": "Sensor",
    "pin": 17,
    "type": "analog",
    "freq": 25,
    "threshold": 1,
    "group": "hardware",
    "tags": [
      "input",
      "analog"
    ],
    "label": "Analog Sensor",
    "icon": {},
    "description": "Measure values that change smoothly, like temperature, pressure, or how bright something is"
  },
  "id": "del9xeakh1f",
  "type": "Sensor",
  "position": {
    "x": 1320.3683783790718,
    "y": 1477.9477445465948
  },
  "measured": {
    "width": 320,
    "height": 219
  },
  "selected": true
}
];

const initialEdges: Edge[] = [

];

export const useReactFlowStore = create<ReactFlowState>()((set, get) => {
  const _internalUpdateFlow = new Debouncer(
    async () => {
      if (!isDesktop()) return;
      const { nodes, edges } = get();
      console.log("[REACT-FLOW] <flowChanged>", nodes, edges);
      const response = await invokeCommand({
        type: "flow_update",
        flow: { nodes, edges },
      });

      if (!response.success) {
        console.error(
          "[NODE-CONTROLS] <flowChanged> failed to update the flow",
          response.error
        );
        return;
      }
    },
    { wait: 500 }
  );

  // Trigger initial flow sync on store creation
  if (isDesktop()) {
    console.log("[REACT-FLOW] Triggering initial flow sync...");
    setTimeout(() => {
      _internalUpdateFlow.maybeExecute();
    }, 100);
  }

  return {
    nodes: initialNodes,
    edges: initialEdges,
    copiedNodes: [],
    updateFlow: () => {
      _internalUpdateFlow.maybeExecute();
    },

    onNodesChange: (changes) => {
      set({ nodes: applyNodeChanges(changes, get().nodes) });

      const hasChanges = changes.some(
        (change) => change.type === "add" || change.type === "remove"
      );
      // if we have some new nodes or deleted nodes, we need to update the flow
      if (!hasChanges) return;
      get().updateFlow();
    },

    onEdgesChange: (changes) => {
      set({ edges: applyEdgeChanges(changes, get().edges) });

      // if we have some new edges or deleted edges, we need to update the flow
      const hasChanges = changes.some(
        (change) => change.type === "add" || change.type === "remove"
      );
      if (!hasChanges) return;
      get().updateFlow();
    },

    onConnect: (connection) => {
      set({
        edges: addEdge(
          { ...connection, id: uid(), type: "animated" },
          get().edges
        ),
      });
      get().updateFlow();
    },

    setNodes: (nodes) => {
      set({ nodes });
      get().updateFlow();
    },

    setEdges: (edges) => {
      set({ edges });
      get().updateFlow();
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
      get().updateFlow();
    },
  };
});

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

export function useUpdateFlow() {
  return useReactFlowStore(useShallow((state) => state.updateFlow));
}
