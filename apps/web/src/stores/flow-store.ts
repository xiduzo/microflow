import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import { toast } from "sonner";
import { Debouncer } from "@tanstack/react-pacer";
import { FlowDocument, type FlowNode, type FlowEdge } from "@microflow/collab";
import type {
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
  XYPosition,
  NodeChange,
  EdgeChange,
} from "@xyflow/react";
import { isDesktop } from "@/lib/platform";
import { invokeCommand } from "@/lib/ipc";
import { useMqttBrokerStore } from "@/stores/mqtt-broker";
import { useFigmaStore } from "@/stores/figma";

// ============================================================================
// Constants
// ============================================================================

const LOCAL_FLOW_STORAGE_KEY = "microflow-local-flow";

// ============================================================================
// Types
// ============================================================================

export type FlowMode = "local" | "cloud";

export type FlowState = {
  // The FlowDocument is the single source of truth
  flowDoc: FlowDocument | null;

  // Mode and identifiers
  mode: FlowMode;
  flowId: string | null;

  // UI state (not persisted in Yjs)
  copiedNodes: FlowNode[];

  // Actions
  initLocalFlow: () => void;
  initCloudFlow: (flowId: string, initialData?: Uint8Array, meta?: { name?: string; description?: string }) => void;

  // ReactFlow callbacks (these modify the FlowDocument)
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;

  // Node operations
  addNode: (node: FlowNode) => void;
  removeNode: (nodeId: string) => void;
  updateNode: (nodeId: string, updates: Partial<FlowNode>) => void;
  updateNodeData: (nodeId: string, data: Record<string, unknown>) => void;

  // Edge operations
  addEdge: (edge: FlowEdge) => void;
  removeEdge: (edgeId: string) => void;

  // Clipboard
  selectAll: () => void;
  copy: (selectedNodes?: FlowNode[]) => void;
  paste: (cursorPosition: XYPosition) => void;

  // History (delegates to FlowDocument's UndoManager)
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // Cleanup
  destroy: () => void;
};

// ============================================================================
// Helpers
// ============================================================================

const uid = () => Math.random().toString(36).substring(2, 9);

function loadLocalFlowData(): { nodes: FlowNode[]; edges: FlowEdge[] } {
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

function saveLocalFlowData(nodes: FlowNode[], edges: FlowEdge[]): void {
  try {
    localStorage.setItem(LOCAL_FLOW_STORAGE_KEY, JSON.stringify({ nodes, edges }));
  } catch (e) {
    console.error("[FLOW-STORE] Failed to save local flow:", e);
  }
}

// ============================================================================
// Store
// ============================================================================

export const useFlowStore = create<FlowState>()((set, get) => {
  // Debounced sync to desktop app and localStorage
  const debouncedSync = new Debouncer(
    async () => {
      const { flowDoc, mode } = get();
      if (!flowDoc) return;

      const nodes = flowDoc.getNodes();
      const edges = flowDoc.getEdges();

      // Save to localStorage for local flows
      if (mode === "local") {
        saveLocalFlowData(nodes, edges);
      }

      // Sync to desktop app if running in Tauri
      if (isDesktop()) {
        // Always inject the current username as uniqueId for Figma nodes
        const figmaUniqueId = useFigmaStore.getState().uniqueId;
        if (figmaUniqueId) {
          for (const node of nodes) {
            if (node.data?.instance === "Figma") {
              node.data = { ...node.data, uniqueId: figmaUniqueId };
            }
          }
        }

        // Get broker configs for any MQTT or Figma nodes in the flow
        const mqttBrokerIds = new Set<string>();
        for (const node of nodes) {
          const instance = node.data?.instance;
          if ((instance === "Mqtt" || instance === "Figma") && node.data?.brokerId) {
            mqttBrokerIds.add(node.data.brokerId as string);
          }
        }
        
        // Get full broker configs from the store
        const allBrokers = useMqttBrokerStore.getState().brokers;
        const brokers = allBrokers
          .filter(b => mqttBrokerIds.has(b.id))
          .map(b => ({
            id: b.id,
            name: b.name,
            url: b.url,
            username: b.username,
            password: b.password,
          }));

        // Pass LLM provider configs so the backend can inject base_url/api_key into LLM nodes
        const { useLlmProviderStore } = await import("@/stores/llm-provider");
        const allProviders = useLlmProviderStore.getState().providers;
        const providers = allProviders.map((p) => ({
          id: p.id, name: p.name, base_url: p.baseUrl, api_key: p.apiKey,
        }));

        const response = await invokeCommand({
          type: "flow_update",
          flow: { nodes, edges },
          brokers,
          providers,
        });
        if (!response.success) {
          console.error("[FLOW-STORE] Desktop sync failed:", response.error);
        }
      }
    },
    { wait: 500 },
  );

  // Subscribe to FlowDocument changes for syncing
  const setupDocSync = (flowDoc: FlowDocument) => {
    return flowDoc.onAnyChange(() => {
      debouncedSync.maybeExecute();
    });
  };

  let unsubscribeDoc: (() => void) | null = null;

  return {
    flowDoc: null,
    mode: "local",
    flowId: null,
    copiedNodes: [],

    // --------------------------------------------------------------------------
    // Initialization
    // --------------------------------------------------------------------------

    initLocalFlow: () => {
      // Cleanup previous
      unsubscribeDoc?.();
      get().flowDoc?.destroy();

      // Create new FlowDocument
      const flowDoc = FlowDocument.createEmpty();

      // Set metadata for local flow
      flowDoc.setMeta({
        name: "Local Flow",
        description: "Local development flow",
      });

      // Load saved data
      const { nodes, edges } = loadLocalFlowData();
      if (nodes.length > 0 || edges.length > 0) {
        flowDoc.setFlowData(nodes, edges);
        flowDoc.clearHistory(); // Don't include initial load in undo history
      }

      // Setup sync
      unsubscribeDoc = setupDocSync(flowDoc);

      set({ flowDoc, mode: "local", flowId: "local" });
      console.log("[FLOW-STORE] Initialized local flow");

      // Trigger initial sync so the backend gets the flow on startup
      // (needed to set up MQTT subscriptions for nodes already in the flow)
      debouncedSync.maybeExecute();
    },

    initCloudFlow: (flowId, initialData, meta) => {
      // Cleanup previous
      unsubscribeDoc?.();
      get().flowDoc?.destroy();

      // Create FlowDocument from server data or empty
      const flowDoc = initialData ? FlowDocument.decode(initialData) : FlowDocument.createEmpty();

      // Set metadata if provided
      if (meta) {
        flowDoc.setMeta({
          name: meta.name,
          description: meta.description,
        });
      }

      flowDoc.clearHistory(); // Don't include initial load in undo history

      // Setup sync (for desktop app)
      unsubscribeDoc = setupDocSync(flowDoc);

      set({ flowDoc, mode: "cloud", flowId });
      console.log(`[FLOW-STORE] Initialized cloud flow: ${flowId}`);

      // Trigger initial sync so the backend gets the flow on startup
      debouncedSync.maybeExecute();
    },

    // --------------------------------------------------------------------------
    // ReactFlow Callbacks
    // --------------------------------------------------------------------------

    onNodesChange: (changes: NodeChange[]) => {
      const { flowDoc } = get();
      if (!flowDoc) return;

      for (const change of changes) {
        switch (change.type) {
          case "position":
            if (change.position && !change.dragging) {
              // Only update on drag end to reduce updates
              flowDoc.updateNodePosition(change.id, change.position);
            } else if (change.position && change.dragging) {
              // During drag, update without adding to undo stack
              flowDoc.doc.transact(() => {
                const node = flowDoc.nodes.get(change.id);
                if (node && change.position) {
                  flowDoc.nodes.set(change.id, { ...node, position: change.position });
                }
              }, "drag"); // Use different origin to skip undo tracking
            }
            break;

          case "dimensions":
            if (change.dimensions) {
              flowDoc.updateNode(change.id, {
                width: change.dimensions.width,
                height: change.dimensions.height,
              });
            }
            break;

          case "select":
            // Selection is UI-only, don't persist
            break;

          case "remove":
            flowDoc.removeNode(change.id);
            break;

          case "add":
            if (change.item) {
              flowDoc.addNode(change.item as FlowNode);
            }
            break;

          case "replace":
            if (change.item) {
              const node = change.item as FlowNode;
              // Never persist UI-only fields (selected, dragging). Each Leva
              // edit sends the full node with selected:true; writing that into
              // Yjs would leave multiple nodes with selected:true over time.
              flowDoc.updateNode(node.id, { ...node, selected: undefined, dragging: undefined });
            }
            break;
        }
      }
    },

    onEdgesChange: (changes: EdgeChange[]) => {
      const { flowDoc } = get();
      if (!flowDoc) return;

      for (const change of changes) {
        switch (change.type) {
          case "remove":
            flowDoc.removeEdge(change.id);
            break;

          case "add":
            if (change.item) {
              flowDoc.addEdge(change.item as FlowEdge);
            }
            break;

          case "select":
            // Selection is UI-only
            break;
        }
      }
    },

    onConnect: (connection) => {
      const { flowDoc } = get();
      if (!flowDoc) return;

      const edge: FlowEdge = {
        id: uid(),
        source: connection.source!,
        sourceHandle: connection.sourceHandle ?? undefined,
        target: connection.target!,
        targetHandle: connection.targetHandle ?? undefined,
        type: "animated",
      };

      flowDoc.addEdge(edge);
    },

    // --------------------------------------------------------------------------
    // Node Operations
    // --------------------------------------------------------------------------

    addNode: (node) => {
      get().flowDoc?.addNode(node);
    },

    removeNode: (nodeId) => {
      get().flowDoc?.removeNode(nodeId);
    },

    updateNode: (nodeId, updates) => {
      get().flowDoc?.updateNode(nodeId, updates);
    },

    updateNodeData: (nodeId, data) => {
      get().flowDoc?.updateNodeData(nodeId, data);
    },

    // --------------------------------------------------------------------------
    // Edge Operations
    // --------------------------------------------------------------------------

    addEdge: (edge) => {
      get().flowDoc?.addEdge(edge);
    },

    removeEdge: (edgeId) => {
      get().flowDoc?.removeEdge(edgeId);
    },

    // --------------------------------------------------------------------------
    // Clipboard
    // --------------------------------------------------------------------------

    selectAll: () => {
      // Selection is handled by ReactFlow, not persisted
      // This is a no-op in the store
    },

    copy: (selectedNodes) => {
      const { flowDoc } = get();
      if (!flowDoc) return;

      // Use provided selected nodes (from ReactFlow state) or fall back to flowDoc
      const nodes = selectedNodes ?? flowDoc.getNodes().filter((n) => n.selected);
      if (nodes.length === 0) {
        toast.info("No nodes selected");
        return;
      }

      set({ copiedNodes: nodes });
      toast.success(`Copied ${nodes.length} node(s)`);
    },

    paste: (cursorPosition) => {
      const { flowDoc, copiedNodes } = get();
      if (!flowDoc || copiedNodes.length === 0) return;

      // Calculate offset to center pasted nodes at cursor
      const nodeCount = copiedNodes.length;
      const { sumX, sumY } = copiedNodes.reduce(
        (acc, node) => ({
          sumX: acc.sumX + node.position.x + (node.width ?? 100) / 2,
          sumY: acc.sumY + node.position.y + (node.height ?? 50) / 2,
        }),
        { sumX: 0, sumY: 0 },
      );

      const offsetX = cursorPosition.x - sumX / nodeCount;
      const offsetY = cursorPosition.y - sumY / nodeCount;

      // Add new nodes with offset positions and new IDs
      flowDoc.doc.transact(() => {
        for (const node of copiedNodes) {
          const newNode: FlowNode = {
            ...node,
            id: uid(),
            position: {
              x: node.position.x + offsetX,
              y: node.position.y + offsetY,
            },
            selected: false,
          };
          flowDoc.nodes.set(newNode.id, newNode);
        }
      }, "local");

      toast.success(`Pasted ${copiedNodes.length} node(s)`);
    },

    // --------------------------------------------------------------------------
    // History
    // --------------------------------------------------------------------------

    undo: () => {
      get().flowDoc?.undo();
    },

    redo: () => {
      get().flowDoc?.redo();
    },

    canUndo: () => {
      return get().flowDoc?.canUndo() ?? false;
    },

    canRedo: () => {
      return get().flowDoc?.canRedo() ?? false;
    },

    // --------------------------------------------------------------------------
    // Cleanup
    // --------------------------------------------------------------------------

    destroy: () => {
      unsubscribeDoc?.();
      get().flowDoc?.destroy();
      set({ flowDoc: null, flowId: null, copiedNodes: [] });
    },
  };
});

// ============================================================================
// Selector Hooks
// ============================================================================

export function useFlowDocument() {
  return useFlowStore((state) => state.flowDoc);
}

export function useFlowMode() {
  return useFlowStore(
    useShallow((state) => ({
      mode: state.mode,
      flowId: state.flowId,
    })),
  );
}

export function useFlowActions() {
  return useFlowStore(
    useShallow((state) => ({
      onNodesChange: state.onNodesChange,
      onEdgesChange: state.onEdgesChange,
      onConnect: state.onConnect,
      addNode: state.addNode,
      removeNode: state.removeNode,
      updateNode: state.updateNode,
      updateNodeData: state.updateNodeData,
    })),
  );
}

export function useFlowClipboard() {
  return useFlowStore(
    useShallow((state) => ({
      selectAll: state.selectAll,
      copy: state.copy,
      paste: state.paste,
    })),
  );
}

export function useFlowHistoryActions() {
  return useFlowStore(
    useShallow((state) => ({
      undo: state.undo,
      redo: state.redo,
      canUndo: state.canUndo,
      canRedo: state.canRedo,
    })),
  );
}

export function useFlowInit() {
  return useFlowStore(
    useShallow((state) => ({
      initLocalFlow: state.initLocalFlow,
      initCloudFlow: state.initCloudFlow,
      destroy: state.destroy,
    })),
  );
}
