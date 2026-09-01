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

/** Whether two snapshots differ in any way a consumer can observe. */
function snapshotsEqual(a: FlowSyncSnapshot, b: FlowSyncSnapshot): boolean {
  return (
    a.mode === b.mode &&
    a.state === b.state &&
    a.isSynced === b.isSynced &&
    a.error === b.error &&
    a.localUser === b.localUser &&
    a.remote === b.remote &&
    a.users === b.users
  );
}

/**
 * Read-only reactive view of the session's sync state.
 *
 * `buildSnapshot` returns a fresh object literal every call, so publishing it
 * unconditionally on every adapter event re-renders every consumer — and
 * awareness events are the highest-frequency events in the editor. The
 * equality check keeps the previous reference when nothing observable moved.
 *
 * Anything that renders presence belongs on a slice from `presence.ts`
 * instead: this snapshot is for connection state.
 */
export function useFlowSync(): FlowSyncSnapshot {
  const session = useFlowSession();
  const [snapshot, setSnapshot] = useState<FlowSyncSnapshot>(() => buildSnapshot(session));

  useEffect(() => {
    const rebuild = () =>
      setSnapshot((previous) => {
        const next = buildSnapshot(session);
        return snapshotsEqual(previous, next) ? previous : next;
      });

    rebuild();
    if (!isRemoteSyncAdapter(session.sync)) return;
    const adapter = session.sync;
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
