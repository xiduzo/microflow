import { useEffect, useState } from "react";
import { useFlowSession } from "./use-flow-session";
import { isRemoteSyncAdapter, type RemoteSyncAdapter } from "./sync-adapter";
import type { FlowSession } from "./flow-session";
import type { SyncState, AwarenessUser } from "@microflow/collab";

export type FlowSyncSnapshot = {
  mode: "local" | "cloud";
  state: SyncState;
  isConnected: boolean;
  isSynced: boolean;
  error: Error | null;
  users: AwarenessUser[];
  localUser: AwarenessUser | null;
  remote: RemoteSyncAdapter | null;
};

const LOCAL_SNAPSHOT: FlowSyncSnapshot = {
  mode: "local",
  state: "synced",
  isConnected: false,
  isSynced: true,
  error: null,
  users: [],
  localUser: null,
  remote: null,
};

function buildSnapshot(session: FlowSession): FlowSyncSnapshot {
  if (!isRemoteSyncAdapter(session.sync)) return LOCAL_SNAPSHOT;
  const adapter = session.sync;
  return {
    mode: "cloud",
    state: adapter.state,
    isConnected: adapter.state === "syncing" || adapter.state === "synced",
    isSynced: adapter.isSynced,
    error: adapter.error,
    users: adapter.users,
    localUser: adapter.localUser,
    remote: adapter,
  };
}

/**
 * Read-only reactive view of the session's sync state. Backed by
 * `useState` + adapter event subscriptions — the snapshot reference is
 * stable between adapter events so it does not trigger render loops in
 * consumers (`useSyncExternalStore` would require explicit cache keying
 * since every `buildSnapshot` call returns a new object literal).
 */
export function useFlowSync(): FlowSyncSnapshot {
  const session = useFlowSession();
  const [snapshot, setSnapshot] = useState<FlowSyncSnapshot>(() => buildSnapshot(session));

  useEffect(() => {
    setSnapshot(buildSnapshot(session));
    if (!isRemoteSyncAdapter(session.sync)) return;
    const adapter = session.sync;
    const rebuild = () => setSnapshot(buildSnapshot(session));
    const unsubs = [
      adapter.on("state", rebuild),
      adapter.on("awareness", rebuild),
      adapter.on("error", rebuild),
      adapter.on("synced", rebuild),
    ];
    return () => unsubs.forEach((u) => u());
  }, [session]);

  return snapshot;
}

export function useFlowAwareness() {
  const { remote } = useFlowSync();
  return {
    updateCursor: (cursor: { x: number; y: number }) => remote?.updateCursor(cursor),
    updateSelectedNodes: (ids: string[]) => remote?.updateSelectedNodes(ids),
  };
}

export function useCollabPresence(): {
  users: AwarenessUser[];
  otherUsers: AwarenessUser[];
  localUser: AwarenessUser | null;
  totalUsers: number;
} {
  const { users, localUser } = useFlowSync();
  const localClientId = localUser?.clientId;
  const otherUsers =
    localClientId == null ? users : users.filter((u) => u.clientId !== localClientId);
  return { users, otherUsers, localUser, totalUsers: users.length };
}
