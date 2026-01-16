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

const LOCAL_FLOW_STORAGE_KEY = "microflow-local-flow";

type HistoryEntry = {
  nodes: Node[];
  edges: Edge[];
};

export type FlowState = {
  nodes: Node[];
  edges: Edge[];
  copiedNodes: Node[];
  history: HistoryEntry[];
  historyIndex: number;
  maxHistorySize: number;
  isCollabActive: boolean;
  collabFlowId: string | null;
  currentFlowId: string | null;

  updateFlow: () => void;
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  addNode: (node: Node) => void;
  removeNode: (nodeId: string) => void;
  updateNode: (nodeId: string, data: Partial<Node>) => void;
  selectAll: () => void;
  copy: () => void;
  paste: (cursorCanvasPosition: XYPosition) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  pushHistory: () => void;
  enableCollab: (flowId: string) => void;
  disableCollab: () => void;
  loadLocalFlow: () => void;
  loadCloudFlow: (flowId: string, nodes: Node[], edges: Edge[]) => void;
};

const uid = () => Math.random().toString(36).substring(2, 9);

// Helper to load local flow from localStorage
function getLocalFlowData(): { nodes: Node[]; edges: Edge[] } {
  try {
    const stored = localStorage.getItem(LOCAL_FLOW_STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored);
      return { nodes: data.nodes ?? [], edges: data.edges ?? [] };
    }
  } catch (e) {
    console.error("[FLOW-STORE] Failed to load local flow:", e);
  }
  return { nodes: [], edges: [] };
}

// Helper to save local flow to localStorage
function saveLocalFlowData(nodes: Node[], edges: Edge[]) {
  try {
    localStorage.setItem(LOCAL_FLOW_STORAGE_KEY, JSON.stringify({ nodes, edges }));
  } catch (e) {
    console.error("[FLOW-STORE] Failed to save local flow:", e);
  }
}


export const useFlowStore = create<FlowState>()(
  (set, get) => {
    const _internalUpdateFlow = new Debouncer(
      async () => {
        const { nodes, edges, currentFlowId } = get();
        
        // Save to localStorage for local flows
        if (currentFlowId === "local") {
          saveLocalFlowData(nodes, edges);
        }
        
        if (!isDesktop()) return;
        console.log("[FLOW-STORE] <flowChanged>", nodes, edges);
        const response = await invokeCommand({
          type: "flow_update",
          flow: { nodes, edges },
        });
        if (!response.success) {
          console.error("[FLOW-STORE] <flowChanged> failed to update the flow", response.error);
        }
      },
      { wait: 500 }
    );

    if (isDesktop()) {
      console.log("[FLOW-STORE] Triggering initial flow sync...");
      setTimeout(() => _internalUpdateFlow.maybeExecute(), 100);
    }

    const pushHistory = () => {
      const { nodes, edges, history, historyIndex, maxHistorySize } = get();
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push({
        nodes: JSON.parse(JSON.stringify(nodes)),
        edges: JSON.parse(JSON.stringify(edges)),
      });
      if (newHistory.length > maxHistorySize) newHistory.shift();
      set({ history: newHistory, historyIndex: newHistory.length - 1 });
    };

    // Load initial local flow data
    const initialData = getLocalFlowData();

    return {
      nodes: initialData.nodes,
      edges: initialData.edges,
      copiedNodes: [],
      history: [{ nodes: [], edges: [] }],
      historyIndex: 0,
      maxHistorySize: 50,
      isCollabActive: false,
      collabFlowId: null,
      currentFlowId: "local",

      updateFlow: () => _internalUpdateFlow.maybeExecute(),

      onNodesChange: (changes) => {
        set({ nodes: applyNodeChanges(changes, get().nodes) });
        const hasStructural = changes.some((c) => c.type === "add" || c.type === "remove");
        const hasPositionEnd = changes.some((c) => c.type === "position" && c.dragging === false);
        if (hasStructural || hasPositionEnd) {
          pushHistory();
          get().updateFlow();
        }
      },

      onEdgesChange: (changes) => {
        set({ edges: applyEdgeChanges(changes, get().edges) });
        if (changes.some((c) => c.type === "add" || c.type === "remove")) {
          pushHistory();
          get().updateFlow();
        }
      },

      onConnect: (connection) => {
        set({ edges: addEdge({ ...connection, id: uid(), type: "animated" }, get().edges) });
        pushHistory();
        get().updateFlow();
      },

      setNodes: (nodes) => { set({ nodes }); pushHistory(); get().updateFlow(); },
      setEdges: (edges) => { set({ edges }); pushHistory(); get().updateFlow(); },

      addNode: (node) => {
        set({ nodes: [...get().nodes, node] });
        pushHistory();
        get().updateFlow();
      },

      removeNode: (nodeId) => {
        set({
          nodes: get().nodes.filter((n) => n.id !== nodeId),
          edges: get().edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
        });
        pushHistory();
        get().updateFlow();
      },

      updateNode: (nodeId, data) => {
        set({ nodes: get().nodes.map((n) => (n.id === nodeId ? { ...n, ...data } : n)) });
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
        toast.success(`Copied ${selectedNodes.length} nodes`);
      },

      paste: (cursorCanvasPosition: XYPosition) => {
        const copiedNodes = get().copiedNodes;
        if (copiedNodes.length === 0) return;
        const nodeCount = copiedNodes.length;
        const { sumX, sumY } = copiedNodes.reduce(
          (acc, node) => ({
            sumX: acc.sumX + node.position.x + (node.width ?? node.measured?.width ?? 0) / 2,
            sumY: acc.sumY + node.position.y + (node.height ?? node.measured?.height ?? 0) / 2,
          }),
          { sumX: 0, sumY: 0 }
        );
        const offsetX = cursorCanvasPosition.x - sumX / nodeCount;
        const offsetY = cursorCanvasPosition.y - sumY / nodeCount;
        set({
          nodes: [
            ...copiedNodes.map((node) => ({
              ...node,
              position: { x: node.position.x + offsetX, y: node.position.y + offsetY },
              selected: false,
              id: uid(),
            })),
            ...get().nodes,
          ],
        });
        pushHistory();
        get().updateFlow();
      },

      pushHistory,

      undo: () => {
        const { history, historyIndex } = get();
        if (historyIndex <= 0) return;
        const newIndex = historyIndex - 1;
        const entry = history[newIndex];
        set({
          nodes: JSON.parse(JSON.stringify(entry.nodes)),
          edges: JSON.parse(JSON.stringify(entry.edges)),
          historyIndex: newIndex,
        });
        get().updateFlow();
      },

      redo: () => {
        const { history, historyIndex } = get();
        if (historyIndex >= history.length - 1) return;
        const newIndex = historyIndex + 1;
        const entry = history[newIndex];
        set({
          nodes: JSON.parse(JSON.stringify(entry.nodes)),
          edges: JSON.parse(JSON.stringify(entry.edges)),
          historyIndex: newIndex,
        });
        get().updateFlow();
      },

      canUndo: () => get().historyIndex > 0,
      canRedo: () => get().historyIndex < get().history.length - 1,

      enableCollab: (flowId) => set({ isCollabActive: true, collabFlowId: flowId }),
      disableCollab: () => set({ isCollabActive: false, collabFlowId: null }),

      loadLocalFlow: () => {
        const data = getLocalFlowData();
        set({ 
          nodes: data.nodes, 
          edges: data.edges, 
          currentFlowId: "local",
          history: [{ nodes: data.nodes, edges: data.edges }],
          historyIndex: 0,
        });
      },

      loadCloudFlow: (flowId, nodes, edges) => {
        set({ 
          nodes, 
          edges, 
          currentFlowId: flowId,
          history: [{ nodes, edges }],
          historyIndex: 0,
        });
      },
    };
  }
);

export function useFlowCanvas() {
  return useFlowStore(
    useShallow((state) => ({
      nodes: state.nodes,
      edges: state.edges,
      onNodesChange: state.onNodesChange,
      onEdgesChange: state.onEdgesChange,
      onConnect: state.onConnect,
    }))
  );
}

export function useFlowHelpers() {
  return useFlowStore(
    useShallow((state) => ({
      selectAll: state.selectAll,
      copy: state.copy,
      paste: state.paste,
    }))
  );
}

export function useFlowHistory() {
  return useFlowStore(
    useShallow((state) => ({
      undo: state.undo,
      redo: state.redo,
      canUndo: state.canUndo,
      canRedo: state.canRedo,
    }))
  );
}

export function useFlowCollab() {
  return useFlowStore(
    useShallow((state) => ({
      isCollabActive: state.isCollabActive,
      collabFlowId: state.collabFlowId,
      enableCollab: state.enableCollab,
      disableCollab: state.disableCollab,
    }))
  );
}

export function useFlowLoader() {
  return useFlowStore(
    useShallow((state) => ({
      loadLocalFlow: state.loadLocalFlow,
      loadCloudFlow: state.loadCloudFlow,
      currentFlowId: state.currentFlowId,
    }))
  );
}

export function useUpdateFlow() {
  return useFlowStore(useShallow((state) => state.updateFlow));
}
