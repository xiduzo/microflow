import { useEffect, useCallback, useMemo } from "react";
import { useFlowStore, useFlowDocument } from "@/stores/flow-store";
import { useSyncProvider, useCollabPresence } from "./use-sync-provider";
import { useFlowNodes, useFlowEdges, useFlowHistory } from "./use-flow-document";

// ============================================================================
// Types
// ============================================================================

export type UseCollabFlowOptions = {
  flowId: string;
  userId: string;
  userName: string;
  initialData?: Uint8Array;
  wsUrl?: string;
};

// ============================================================================
// useCollabFlow - Main hook for collaborative flow editing
// ============================================================================

export function useCollabFlow(options: UseCollabFlowOptions) {
  const { flowId, userId, userName, initialData, wsUrl } = options;

  const initCloudFlow = useFlowStore((s) => s.initCloudFlow);
  const destroy = useFlowStore((s) => s.destroy);
  const flowDoc = useFlowDocument();

  // Initialize the flow document
  useEffect(() => {
    initCloudFlow(flowId, initialData);

    return () => {
      destroy();
    };
  }, [flowId, initialData, initCloudFlow, destroy]);

  // User object for sync provider
  const user = useMemo(() => ({ id: userId, name: userName }), [userId, userName]);

  // Connect to sync provider
  const sync = useSyncProvider({
    flowDoc,
    flowId,
    user,
    wsUrl,
    enabled: !!flowDoc,
  });

  // Get reactive data from FlowDocument
  const nodes = useFlowNodes(flowDoc);
  const edges = useFlowEdges(flowDoc);
  const history = useFlowHistory(flowDoc);

  // Presence
  const presence = useCollabPresence(sync);

  return {
    // Data
    nodes,
    edges,
    flowDoc,

    // Sync state
    isConnected: sync.isConnected,
    isSynced: sync.isSynced,
    syncState: sync.state,
    syncError: sync.error,

    // Presence
    users: presence.otherUsers,
    localUser: presence.localUser,
    totalUsers: presence.totalUsers,

    // Awareness actions
    updateCursor: sync.updateCursor,
    updateSelectedNodes: sync.updateSelectedNodes,

    // History
    ...history,

    // Connection control
    reconnect: sync.reconnect,
    disconnect: sync.disconnect,
  };
}

// ============================================================================
// useLocalFlow - Hook for local (non-collaborative) flow editing
// ============================================================================

export function useLocalFlow() {
  const initLocalFlow = useFlowStore((s) => s.initLocalFlow);
  const destroy = useFlowStore((s) => s.destroy);
  const flowDoc = useFlowDocument();

  // Initialize local flow
  useEffect(() => {
    initLocalFlow();

    return () => {
      destroy();
    };
  }, [initLocalFlow, destroy]);

  // Get reactive data
  const nodes = useFlowNodes(flowDoc);
  const edges = useFlowEdges(flowDoc);
  const history = useFlowHistory(flowDoc);

  return {
    nodes,
    edges,
    flowDoc,
    ...history,
  };
}

// ============================================================================
// useCollabCursor - Track and broadcast cursor position
// ============================================================================

export function useCollabCursor(updateCursor: (cursor: { x: number; y: number }) => void) {
  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      updateCursor({ x: event.clientX, y: event.clientY });
    },
    [updateCursor],
  );

  return { onMouseMove: handleMouseMove };
}
