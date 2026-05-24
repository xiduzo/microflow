import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { EdgeChange, NodeChange } from "@xyflow/react";
import type { FlowDocument } from "@microflow/collab";
import { ReactFlowBridge } from "./react-flow-bridge";

/**
 * Thin React adapter over `ReactFlowBridge`. Bridge is constructed once
 * per mount via `useState` lazy init (Strict Mode-safe — the state slot
 * survives the double-mount cycle), torn down on unmount.
 *
 * `doc` is expected to be invariant across the hook's lifetime — held by
 * the surrounding `FlowSession`, which never swaps its underlying doc.
 */
export function useReactFlowBridge(doc: FlowDocument) {
  const [bridge] = useState(() => new ReactFlowBridge(doc));

  useEffect(() => () => bridge.destroy(), [bridge]);

  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => bridge.applyNodeChanges(changes),
    [bridge],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => bridge.applyEdgeChanges(changes),
    [bridge],
  );

  return {
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    onNodesChange,
    onEdgesChange,
  };
}
