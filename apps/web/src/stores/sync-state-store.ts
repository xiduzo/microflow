import { create } from "zustand";
import type { SyncState, AwarenessUser } from "@microflow/collab";

export type SyncStateStore = {
  // Per-flow sync state
  flowStates: Map<string, {
    state: SyncState;
    isConnected: boolean;
    isSynced: boolean;
    error: Error | null;
    users: AwarenessUser[];
    localUser: AwarenessUser | null;
    lastSyncedAt: number | null;
  }>;
  
  // Actions
  setFlowState: (flowId: string, state: {
    state: SyncState;
    isConnected: boolean;
    isSynced: boolean;
    error: Error | null;
    users: AwarenessUser[];
    localUser: AwarenessUser | null;
    lastSyncedAt?: number | null;
  }) => void;
  
  clearFlowState: (flowId: string) => void;
  
  getFlowState: (flowId: string) => {
    state: SyncState;
    isConnected: boolean;
    isSynced: boolean;
    error: Error | null;
    users: AwarenessUser[];
    localUser: AwarenessUser | null;
    lastSyncedAt: number | null;
  } | null;
};

const DEFAULT_STATE = {
  state: "disconnected" as SyncState,
  isConnected: false,
  isSynced: false,
  error: null,
  users: [],
  localUser: null,
  lastSyncedAt: null,
};

export const useSyncStateStore = create<SyncStateStore>((set, get) => ({
  flowStates: new Map(),
  
  setFlowState: (flowId, state) => {
    set((prev) => {
      const newFlowStates = new Map(prev.flowStates);
      const existingState = newFlowStates.get(flowId);
      // Preserve lastSyncedAt if not provided, or update it when syncing completes
      const lastSyncedAt = 
        state.lastSyncedAt !== undefined 
          ? state.lastSyncedAt 
          : (state.isSynced && state.state === "synced" && !existingState?.isSynced)
            ? Date.now()
            : existingState?.lastSyncedAt ?? null;
      
      newFlowStates.set(flowId, {
        ...state,
        lastSyncedAt,
      });
      return { flowStates: newFlowStates };
    });
  },
  
  clearFlowState: (flowId) => {
    set((prev) => {
      const newFlowStates = new Map(prev.flowStates);
      newFlowStates.delete(flowId);
      return { flowStates: newFlowStates };
    });
  },
  
  getFlowState: (flowId) => {
    return get().flowStates.get(flowId) ?? null;
  },
}));

// Selector hook for specific flow state
export function useFlowSyncState(flowId: string | null) {
  return useSyncStateStore((state) => 
    flowId ? state.flowStates.get(flowId) ?? DEFAULT_STATE : DEFAULT_STATE
  );
}
