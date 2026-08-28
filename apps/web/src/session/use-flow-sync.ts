import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * Prefer the narrower hooks below where they fit: `useFlowAwareness` needs no
 * subscription at all, and `useCollabPresence` is the only thing that should
 * wake for a remote cursor.
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

/**
 * The imperative presence writers — cursor and selection.
 *
 * Deliberately *not* built on `useFlowSync`: this hook only sends, and
 * subscribing to awareness merely to publish a cursor made the canvas
 * re-render on every remote pointer move in the room. The callbacks read the
 * adapter through a ref, so they are stable for the life of the session and
 * do not invalidate their callers' memoisation either.
 */
export function useFlowAwareness() {
  const session = useFlowSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const updateCursor = useCallback((cursor: { x: number; y: number }) => {
    const sync = sessionRef.current.sync;
    if (isRemoteSyncAdapter(sync)) sync.updateCursor(cursor);
  }, []);

  const updateSelectedNodes = useCallback((ids: string[]) => {
    const sync = sessionRef.current.sync;
    if (isRemoteSyncAdapter(sync)) sync.updateSelectedNodes(ids);
  }, []);

  const updateDraggedNodes = useCallback(
    (positions: Record<string, { x: number; y: number }> | null) => {
      const sync = sessionRef.current.sync;
      if (isRemoteSyncAdapter(sync)) sync.updateDraggedNodes(positions);
    },
    [],
  );

  return useMemo(
    () => ({ updateCursor, updateSelectedNodes, updateDraggedNodes }),
    [updateCursor, updateSelectedNodes, updateDraggedNodes],
  );
}

/**
 * Presence for rendering — cursors and the collaborator list.
 *
 * This is the hook that *should* wake on a remote cursor, and the only one.
 * Keep it to components that draw presence (`CollabCursors`, `PressensePanel`)
 * so the rest of the canvas stays still.
 */
export function useCollabPresence(): {
  users: AwarenessUser[];
  otherUsers: AwarenessUser[];
  localUser: AwarenessUser | null;
  totalUsers: number;
} {
  const { users, localUser } = useFlowSync();
  const localClientId = localUser?.clientId;

  // Memoised so a presence event that did not change the roster hands
  // consumers the same array, letting a memo'd cursor layer skip its render.
  const otherUsers = useMemo(
    () => (localClientId == null ? users : users.filter((u) => u.clientId !== localClientId)),
    [users, localClientId],
  );

  return { users, otherUsers, localUser, totalUsers: users.length };
}
