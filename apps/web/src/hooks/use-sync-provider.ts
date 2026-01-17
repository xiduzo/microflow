import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { SyncProvider, type SyncState, type AwarenessUser } from "@microflow/collab";
import type { FlowDocument } from "@microflow/collab";

// ============================================================================
// Types
// ============================================================================

export type UseSyncProviderOptions = {
  flowDoc: FlowDocument | null;
  flowId: string | null;
  user: { id: string; name: string } | null;
  wsUrl?: string;
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
  const { flowDoc, flowId, user, wsUrl, enabled = true } = options;

  const [state, setState] = useState<SyncState>("disconnected");
  const [error, setError] = useState<Error | null>(null);
  const [users, setUsers] = useState<AwarenessUser[]>([]);
  const [localUser, setLocalUser] = useState<AwarenessUser | null>(null);

  const providerRef = useRef<SyncProvider | null>(null);
  const connectedFlowIdRef = useRef<string | null>(null);

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
      return;
    }

    // Skip if already connected to this flow with this doc
    if (connectedFlowIdRef.current === flowId && providerRef.current) {
      return;
    }

    // Cleanup previous provider if switching flows
    if (providerRef.current) {
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
      providerRef.current = null;
      connectedFlowIdRef.current = null;
    };
  }, [enabled, flowDoc, flowId, user?.id, user?.name, computedWsUrl]);

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
  const localUserId = localUser?.id;

  // Memoize to prevent unnecessary re-renders
  const otherUsers = useMemo(
    () => (localUserId ? users.filter((u) => u.id !== localUserId) : []),
    [users, localUserId],
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
