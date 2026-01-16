import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import type { Edge, Node } from "@xyflow/react";
import { useFlowStore } from "./flow-store";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export type AwarenessUser = {
  id: string;
  name: string;
  color: string;
  cursor?: { x: number; y: number };
  selectedNodes?: string[];
};

export type CollabProviderState = {
  // Connection state
  flowId: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;

  // Awareness (presence)
  awareness: Map<number, AwarenessUser>;
  localUser: AwarenessUser | null;

  // Actions
  connect: (flowId: string, user: AwarenessUser, wsUrl: string) => void;
  disconnect: () => void;
  updateCursor: (cursor: { x: number; y: number }) => void;
  updateSelectedNodes: (nodeIds: string[]) => void;
};

// Internal state not exposed to React
let ydoc: Y.Doc | null = null;
let yNodes: Y.Array<Node> | null = null;
let yEdges: Y.Array<Edge> | null = null;
let awareness: awarenessProtocol.Awareness | null = null;
let ws: WebSocket | null = null;
let isRemoteUpdate = false;

export const useCollabProvider = create<CollabProviderState>()((set, get) => {
  // Sync local changes to Yjs
  const syncToYjs = (nodes: Node[], edges: Edge[]) => {
    if (!ydoc || !yNodes || !yEdges || isRemoteUpdate) return;

    ydoc.transact(() => {
      // Clear and replace nodes
      yNodes!.delete(0, yNodes!.length);
      yNodes!.push(nodes);

      // Clear and replace edges
      yEdges!.delete(0, yEdges!.length);
      yEdges!.push(edges);
    });
  };

  const setupYjsObservers = () => {
    if (!yNodes || !yEdges || !awareness) return;

    // When Yjs changes (from remote), update the flow store
    yNodes.observe(() => {
      isRemoteUpdate = true;
      const nodes = yNodes!.toArray();
      useFlowStore.setState({ nodes });
      isRemoteUpdate = false;
    });

    yEdges.observe(() => {
      isRemoteUpdate = true;
      const edges = yEdges!.toArray();
      useFlowStore.setState({ edges });
      isRemoteUpdate = false;
    });

    awareness.on("change", () => {
      const states = awareness!.getStates();
      const awarenessMap = new Map<number, AwarenessUser>();
      states.forEach((state, clientId) => {
        if (state.user) {
          awarenessMap.set(clientId, state.user as AwarenessUser);
        }
      });
      set({ awareness: awarenessMap });
    });
  };

  // Subscribe to flow store changes and sync to Yjs
  const setupFlowStoreSubscription = () => {
    return useFlowStore.subscribe((state, prevState) => {
      if (isRemoteUpdate) return;
      if (!get().isConnected) return;
      
      const nodesChanged = state.nodes !== prevState.nodes;
      const edgesChanged = state.edges !== prevState.edges;
      
      if (nodesChanged || edgesChanged) {
        syncToYjs(state.nodes, state.edges);
      }
    });
  };

  const handleWsMessage = (data: ArrayBuffer) => {
    if (!ydoc || !awareness) return;

    const decoder = decoding.createDecoder(new Uint8Array(data));
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, ydoc, null);
        if (encoding.length(encoder) > 1 && ws?.readyState === WebSocket.OPEN) {
          ws.send(encoding.toUint8Array(encoder));
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          decoding.readVarUint8Array(decoder),
          null
        );
        break;
      }
    }
  };

  let unsubscribe: (() => void) | null = null;

  return {
    flowId: null,
    isConnected: false,
    isConnecting: false,
    error: null,
    awareness: new Map(),
    localUser: null,

    connect: (flowId, user, wsUrl) => {
      // Cleanup existing connection
      get().disconnect();

      set({ isConnecting: true, error: null, flowId, localUser: user });

      // Initialize Yjs
      ydoc = new Y.Doc();
      yNodes = ydoc.getArray<Node>("nodes");
      yEdges = ydoc.getArray<Edge>("edges");
      awareness = new awarenessProtocol.Awareness(ydoc);

      // Set local awareness state
      awareness.setLocalStateField("user", user);

      setupYjsObservers();
      unsubscribe = setupFlowStoreSubscription();

      // Connect WebSocket
      ws = new WebSocket(`${wsUrl}/yjs/${flowId}`);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        set({ isConnected: true, isConnecting: false });
        useFlowStore.getState().enableCollab(flowId);

        // Send initial sync
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, ydoc!);
        ws!.send(encoding.toUint8Array(encoder));
      };

      ws.onmessage = (event) => {
        handleWsMessage(event.data);
      };

      ws.onclose = () => {
        set({ isConnected: false, isConnecting: false });
        useFlowStore.getState().disableCollab();
      };

      ws.onerror = () => {
        set({ error: "WebSocket connection failed", isConnecting: false });
      };

      // Broadcast local changes
      ydoc.on("update", (update: Uint8Array) => {
        if (ws?.readyState === WebSocket.OPEN) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.writeUpdate(encoder, update);
          ws.send(encoding.toUint8Array(encoder));
        }
      });
    },

    disconnect: () => {
      unsubscribe?.();
      unsubscribe = null;
      ws?.close();
      ws = null;
      ydoc?.destroy();
      ydoc = null;
      yNodes = null;
      yEdges = null;
      awareness = null;
      useFlowStore.getState().disableCollab();
      set({
        flowId: null,
        isConnected: false,
        isConnecting: false,
        awareness: new Map(),
        localUser: null,
      });
    },

    updateCursor: (cursor) => {
      if (!awareness) return;
      const user = get().localUser;
      if (user) {
        awareness.setLocalStateField("user", { ...user, cursor });
      }
    },

    updateSelectedNodes: (nodeIds) => {
      if (!awareness) return;
      const user = get().localUser;
      if (user) {
        awareness.setLocalStateField("user", { ...user, selectedNodes: nodeIds });
      }
    },
  };
});

// Hooks for components
export function useCollabConnection() {
  return useCollabProvider(
    useShallow((state) => ({
      flowId: state.flowId,
      isConnected: state.isConnected,
      isConnecting: state.isConnecting,
      error: state.error,
      connect: state.connect,
      disconnect: state.disconnect,
    }))
  );
}

export function useCollabAwareness() {
  return useCollabProvider(
    useShallow((state) => ({
      awareness: state.awareness,
      localUser: state.localUser,
      updateCursor: state.updateCursor,
      updateSelectedNodes: state.updateSelectedNodes,
    }))
  );
}
