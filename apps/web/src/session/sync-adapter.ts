import type { AwarenessUser, SyncProviderEvents, SyncState } from "@microflow/collab";

export type { AwarenessUser, SyncState };

/**
 * The events a remote adapter exposes: the connection/presence subset of the
 * provider's events (`ack` and `accessDenied` stay a transport concern).
 */
export type SyncAdapterEvents = Pick<
  SyncProviderEvents,
  "state" | "awareness" | "synced" | "error"
>;

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
  /** Publish live drag positions, or `null` on drop. See `SyncProvider`. */
  updateDraggedNodes(positions: Record<string, { x: number; y: number }> | null): void;
  reconnect(): void;
  disconnect(): void;
  on<K extends keyof SyncAdapterEvents>(event: K, cb: SyncAdapterEvents[K]): () => void;
};

export function isRemoteSyncAdapter(adapter: SyncAdapter): adapter is RemoteSyncAdapter {
  return adapter.kind === "remote";
}
