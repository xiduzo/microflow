import type { AwarenessUser, SyncState } from "@microflow/collab";

export type { AwarenessUser, SyncState };

export type SyncAdapterEvents = {
  state: (state: SyncState) => void;
  awareness: (users: AwarenessUser[]) => void;
  synced: () => void;
  error: (err: Error) => void;
};

export type SyncAdapter = {
  readonly kind: "local" | "remote";
  destroy(): void;
};

export type RemoteSyncAdapter = SyncAdapter & {
  readonly kind: "remote";
  readonly state: SyncState;
  readonly isSynced: boolean;
  readonly users: AwarenessUser[];
  readonly localUser: AwarenessUser | null;
  readonly error: Error | null;
  updateCursor(cursor: { x: number; y: number }): void;
  updateSelectedNodes(nodeIds: string[]): void;
  reconnect(): void;
  disconnect(): void;
  on<K extends keyof SyncAdapterEvents>(event: K, cb: SyncAdapterEvents[K]): () => void;
};

export function isRemoteSyncAdapter(adapter: SyncAdapter): adapter is RemoteSyncAdapter {
  return adapter.kind === "remote";
}
