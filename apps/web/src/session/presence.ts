import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AwarenessUser } from "@microflow/collab";
import { useFlowSession } from "./use-flow-session";
import { isRemoteSyncAdapter, type SyncAdapter } from "./sync-adapter";

/**
 * Presence — the awareness channel, sliced by what each consumer draws.
 *
 * Awareness is the highest-frequency event source in the editor: every peer's
 * pointer move lands on it. Handing every subscriber the whole user list made
 * each one re-derive its own view and hand-roll an equality check to avoid
 * re-rendering at pointer rate. A `PresenceSlice` packages that pair — derive
 * and compare — so the churn control lives here, once. A consumer subscribes
 * to exactly the fields it renders, and a change to any other field leaves it
 * unrendered.
 *
 * Adding a presence field costs one slice declaration; `usePresence` does the
 * rest.
 */
export type PresenceSlice<T> = {
  /** Derive the view from the room's peers (the local user is already excluded). */
  select(peers: AwarenessUser[]): T;
  /** When this holds, subscribers keep the previous value and do not re-render. */
  equal(a: T, b: T): boolean;
};

/**
 * Peers that are pointing somewhere — the cursor layer's slice. Blind to
 * selection and drag fields, so those changes do not redraw cursors.
 */
export const cursorsSlice: PresenceSlice<AwarenessUser[]> = {
  select: (peers) => peers.filter((peer) => peer.cursor !== undefined),
  equal: (a, b) =>
    a.length === b.length &&
    a.every((peer, i) => {
      const other = b[i]!;
      return (
        peer.id === other.id &&
        peer.name === other.name &&
        peer.color === other.color &&
        peer.isSupporter === other.isSupporter &&
        peer.cursor!.x === other.cursor!.x &&
        peer.cursor!.y === other.cursor!.y
      );
    }),
};

/**
 * Who is in the room — the avatar list. Blind to cursors, so the panel does
 * not re-render at pointer rate.
 */
export const collaboratorsSlice: PresenceSlice<AwarenessUser[]> = {
  select: (peers) => peers,
  equal: (a, b) =>
    a.length === b.length &&
    a.every((peer, i) => {
      const other = b[i]!;
      return (
        peer.id === other.id &&
        peer.name === other.name &&
        peer.color === other.color &&
        peer.icon === other.icon &&
        peer.isSupporter === other.isSupporter
      );
    }),
};

export type DragMap = Record<string, { x: number; y: number }>;

/**
 * Positions from every dragging peer, flattened; `null` when nobody drags.
 * Later peers win on a contested node, which cannot normally happen —
 * ReactFlow only drags what it has grabbed.
 */
export const remoteDragSlice: PresenceSlice<DragMap | null> = {
  select: (peers) => {
    let out: DragMap | null = null;
    for (const peer of peers) {
      if (!peer.draggingNodes) continue;
      out ??= {};
      Object.assign(out, peer.draggingNodes);
    }
    return out;
  },
  equal: (a, b) => {
    if (a === b) return true;
    if (!a || !b) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      const left = a[key]!;
      const right = b[key];
      if (!right || left.x !== right.x || left.y !== right.y) return false;
    }
    return true;
  },
};

function peers(sync: SyncAdapter): AwarenessUser[] {
  if (!isRemoteSyncAdapter(sync)) return [];
  const localClientId = sync.localUser?.clientId;
  return localClientId === undefined
    ? sync.users
    : sync.users.filter((user) => user.clientId !== localClientId);
}

/**
 * Subscribe outside React: `onChange` fires with the current value, then only
 * when the slice itself changes — a peer touching an unrelated field never
 * wakes it.
 */
export function observePresence<T>(
  sync: SyncAdapter,
  slice: PresenceSlice<T>,
  onChange: (value: T) => void,
): () => void {
  let current = slice.select(peers(sync));
  onChange(current);
  if (!isRemoteSyncAdapter(sync)) return () => {};
  return sync.on("awareness", () => {
    const next = slice.select(peers(sync));
    if (slice.equal(current, next)) return;
    current = next;
    onChange(next);
  });
}

/** The React face of `observePresence` — re-renders only when the slice moves. */
export function usePresence<T>(slice: PresenceSlice<T>): T {
  const session = useFlowSession();
  const [value, setValue] = useState<T>(() => slice.select(peers(session.sync)));

  useEffect(() => {
    const apply = (next: T) =>
      setValue((previous) => (slice.equal(previous, next) ? previous : next));
    return observePresence(session.sync, slice, apply);
  }, [session, slice]);

  return value;
}

/**
 * The imperative presence writers — cursor, selection and drag.
 *
 * Deliberately not a subscription: this hook only sends, and subscribing to
 * awareness merely to publish a cursor made the canvas re-render on every
 * remote pointer move in the room. The callbacks read the adapter through a
 * ref, so they are stable for the life of the session and do not invalidate
 * their callers' memoisation either.
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
    (positions: DragMap | null) => {
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
