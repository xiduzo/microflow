import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { SyncProvider, type SyncState, type AwarenessUser } from "@microflow/collab";
import type { FlowDocument } from "@microflow/collab";
import { useSyncStateStore } from "@/stores/sync-state-store";

// ============================================================================
// Types
// ============================================================================

export type UseSyncProviderOptions = {
  flowDoc: FlowDocument | null;
  flowId: string | null;
  user: { id: string; name: string; color?: string; icon?: string } | null;
  wsUrl?: string;
  /** Bearer token for auth (used in Tauri where cookies aren't available) */
  authToken?: string;
  enabled?: boolean;
};

export type UseSyncProviderReturn = {
  state: SyncState;
  isConnected: boolean;
  isSynced: boolean;
  error: Error | null;
  users: AwarenessUser[];
  localUser: AwarenessUser | null;
  updateCursor: (cursor: { x: number; y: number }) => void;
  updateSelectedNodes: (nodeIds: string[]) => void;
  reconnect: () => void;
  disconnect: () => void;
};

// ============================================================================
// useSyncProvider - Connect FlowDocument to server
// ============================================================================

export function useSyncProvider(options: UseSyncProviderOptions): UseSyncProviderReturn {
  const { flowDoc, flowId, user, wsUrl, authToken, enabled = true } = options;

  const [state, setState] = useState<SyncState>("disconnected");
  const [error, setError] = useState<Error | null>(null);
  const [users, setUsers] = useState<AwarenessUser[]>([]);
  const [localUser, setLocalUser] = useState<AwarenessUser | null>(null);

  const providerRef = useRef<SyncProvider | null>(null);
  const connectedFlowIdRef = useRef<string | null>(null);
  
  const { setFlowState, clearFlowState } = useSyncStateStore();

  // Compute WebSocket URL
  const computedWsUrl =
    wsUrl ??
    (typeof window !== "undefined"
      ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`
      : "ws://localhost:3000");

  // Connect/disconnect effect
  useEffect(() => {
    // Check if we should connect
    if (!enabled || !flowDoc || !flowId || !user) {
      // Cleanup if we were connected
      if (providerRef.current) {
        providerRef.current.destroy();
        providerRef.current = null;
        connectedFlowIdRef.current = null;
      }
      setState("disconnected");
      setUsers([]);
      setLocalUser(null);
      
      // Clear global state
      if (flowId) {
        clearFlowState(flowId);
      }
      return;
    }

    // Skip if already connected to this flow with this doc
    if (connectedFlowIdRef.current === flowId && providerRef.current) {
      return;
    }

    // Cleanup previous provider if switching flows
    if (providerRef.current && connectedFlowIdRef.current) {
      clearFlowState(connectedFlowIdRef.current);
      providerRef.current.destroy();
      providerRef.current = null;
    }

    console.log(`[SYNC-HOOK] Creating sync provider for flow ${flowId}`);

    // Create new provider
    const provider = new SyncProvider({
      flowId,
      doc: flowDoc.doc,
      wsUrl: computedWsUrl,
      user,
      authToken,
    });

    providerRef.current = provider;
    connectedFlowIdRef.current = flowId;
    setLocalUser(provider.localUser);

    // Set up event listeners
    const unsubState = provider.on("stateChange", (newState: SyncState) => {
      setState(newState);
      if (newState === "disconnected") {
        setError(null);
      }
    });

    const unsubAwareness = provider.on(
      "awarenessChange",
      (awarenessUsers: Map<number, AwarenessUser>) => {
        const userList = Array.from(awarenessUsers.values());
        setUsers(userList);
      },
    );

    const unsubError = provider.on("error", (err: Error) => {
      setError(err);
    });

    // Cleanup
    return () => {
      console.log(`[SYNC-HOOK] Cleaning up sync provider for flow ${flowId}`);
      unsubState();
      unsubAwareness();
      unsubError();
      provider.destroy();
      clearFlowState(flowId);
      providerRef.current = null;
      connectedFlowIdRef.current = null;
    };
  }, [enabled, flowDoc, flowId, user?.id, user?.name, user?.color, user?.icon, computedWsUrl, authToken, clearFlowState]);

  // Cursor update
  const updateCursor = useCallback(
    (cursor: { x: number; y: number }) => {
      if (state !== "synced" && state !== "syncing") return;
      providerRef.current?.updateCursor(cursor);
    },
    [state],
  );

  // Selected nodes update
  const updateSelectedNodes = useCallback((nodeIds: string[]) => {
    providerRef.current?.updateSelectedNodes(nodeIds);
  }, []);

  // Manual reconnect
  const reconnect = useCallback(() => {
    providerRef.current?.connect();
  }, []);

  // Manual disconnect
  const disconnect = useCallback(() => {
    providerRef.current?.disconnect();
  }, []);

// Sync local state to global store
  useEffect(() => {
    if (flowId) {
      setFlowState(flowId, {
        state,
        isConnected: state === "syncing" || state === "synced",
        isSynced: state === "synced",
        error,
        users,
        localUser,
      });
    }
  }, [flowId, state, error, users, localUser, setFlowState]);

  return {
    state,
    isConnected: state === "syncing" || state === "synced",
    isSynced: state === "synced",
    error,
    users,
    localUser,
    updateCursor,
    updateSelectedNodes,
    reconnect,
    disconnect,
  };
}

// ============================================================================
// useCollabPresence - Get other users' presence
// ============================================================================

export function useCollabPresence(syncResult: UseSyncProviderReturn) {
  const { users, localUser } = syncResult;
  const localClientId = localUser?.clientId;

  // Filter by clientId (unique per connection) instead of user.id (unique per account)
  // This allows the same user to see their own cursor from other tabs/windows
  const otherUsers = useMemo(
    () => (localClientId != null ? users.filter((u) => u.clientId !== localClientId) : []),
    [users, localClientId],
  );

  return useMemo(
    () => ({
      otherUsers,
      localUser,
      totalUsers: users.length,
    }),
    [otherUsers, localUser, users.length],
  );
}
