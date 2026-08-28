import { useCallback, useEffect, useRef, useState } from "react";
import type { NodeChange } from "@xyflow/react";
import type { AwarenessUser, FlowNode } from "@microflow/collab";
import { useFlowSession } from "./use-flow-session";
import { isRemoteSyncAdapter } from "./sync-adapter";
import { useFlowAwareness } from "./use-flow-sync";

/**
 * Live drag positions, both directions.
 *
 * `ReactFlowBridge` classifies a position change as ephemeral while
 * `dragging` is true, so the document only learns where a node ended up. That
 * keeps drag churn out of the CRDT and the undo stack — the right call — but
 * it means peers watch nodes teleport on drop instead of move.
 *
 * Awareness is the right channel for the in-between frames: ephemeral by
 * construction, already throttled, and discarded when the user disconnects.
 * This hook publishes the local drag onto it and overlays everyone else's.
 */

type DragMap = Record<string, { x: number; y: number }>;

/** Positions from every peer, flattened. Later peers win on a contested node,
 *  which cannot normally happen — ReactFlow only drags what it has grabbed. */
function collectRemotePositions(users: AwarenessUser[], localClientId?: number): DragMap | null {
  let out: DragMap | null = null;
  for (const user of users) {
    if (!user.draggingNodes) continue;
    if (localClientId != null && user.clientId === localClientId) continue;
    out ??= {};
    Object.assign(out, user.draggingNodes);
  }
  return out;
}

function dragMapsEqual(a: DragMap | null, b: DragMap | null): boolean {
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
}

/**
 * Peers' in-flight drag positions.
 *
 * Subscribes to awareness directly rather than through `useFlowSync`, and
 * publishes new state only when the drag map itself changes. Going through the
 * shared snapshot would wake this — and therefore the canvas — on every remote
 * cursor move, which is the churn `useFlowAwareness` was just separated out to
 * avoid.
 */
export function useRemoteDragPositions(): DragMap | null {
  const session = useFlowSession();
  const [positions, setPositions] = useState<DragMap | null>(null);

  useEffect(() => {
    const sync = session.sync;
    if (!isRemoteSyncAdapter(sync)) {
      setPositions(null);
      return;
    }

    const update = (users: AwarenessUser[]) =>
      setPositions((previous) => {
        const next = collectRemotePositions(users, sync.localUser?.clientId);
        return dragMapsEqual(previous, next) ? previous : next;
      });

    update(sync.users);
    return sync.on("awareness", update);
  }, [session]);

  return positions;
}

/**
 * Overlay remote drag positions onto the snapshot.
 *
 * Identity is preserved for every node not being dragged elsewhere, so this
 * costs a re-render only for the nodes actually in motion. A node the local
 * user is dragging is never overlaid — our own pointer wins over a stale
 * frame from a peer.
 */
export function applyRemoteDrag(
  nodes: FlowNode[],
  remote: DragMap | null,
): FlowNode[] {
  if (!remote) return nodes;

  let changed = false;
  const next = nodes.map((node) => {
    const position = remote[node.id];
    if (!position || node.dragging) return node;
    if (node.position.x === position.x && node.position.y === position.y) return node;
    changed = true;
    return { ...node, position };
  });

  return changed ? next : nodes;
}

/**
 * Wrap an `onNodesChange` handler so in-flight drags are published to
 * awareness. Returns the wrapped handler; the drag map is derived from the
 * changes themselves, so nothing else has to track drag state.
 */
export function usePublishDrag(
  onNodesChange: (changes: NodeChange[]) => void,
): (changes: NodeChange[]) => void {
  const { updateDraggedNodes } = useFlowAwareness();
  // Ids we are currently telling peers about, so the drop can be published
  // exactly once rather than on every subsequent change batch.
  const activeRef = useRef<Record<string, { x: number; y: number }> | null>(null);

  return useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);

      let dragging: Record<string, { x: number; y: number }> | null = null;
      let sawDragEnd = false;

      for (const change of changes) {
        if (change.type !== "position" || !change.position) continue;
        if (change.dragging) {
          (dragging ??= {})[change.id] = change.position;
        } else {
          sawDragEnd = true;
        }
      }

      if (dragging) {
        activeRef.current = dragging;
        updateDraggedNodes(dragging);
        return;
      }

      // Drop: clear presence so peers fall back to the document position,
      // which the bridge has just written.
      if (sawDragEnd && activeRef.current) {
        activeRef.current = null;
        updateDraggedNodes(null);
      }
    },
    [onNodesChange, updateDraggedNodes],
  );
}
