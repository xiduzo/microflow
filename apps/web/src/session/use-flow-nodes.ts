import { useCallback, useEffect, useRef, useState } from "react";
import type { FlowDocument, FlowNode, FlowEdge } from "@microflow/collab";

/** Element-wise reference equality. */
function sameMembers<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Keep the previous array when the incoming one holds the same members.
 *
 * `doc.getNodes()` allocates a fresh array on every call, but Yjs hands back
 * the same object for a node nobody touched — so an unrelated change produces
 * a new array of identical members. Returning the previous reference stops
 * every downstream `useMemo([nodes])` from re-running for a change that did
 * not touch the collection at all.
 */
function useStableCollection<T>(read: () => T[], subscribe: (cb: () => void) => () => void): T[] {
  const [value, setValue] = useState<T[]>(read);
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    const update = () =>
      setValue((previous) => {
        const next = readRef.current();
        return sameMembers(previous, next) ? previous : next;
      });

    update();
    return subscribe(update);
    // `subscribe` is recreated per doc by the callers below.
  }, [subscribe]);

  return value;
}

export function useFlowNodes(doc: FlowDocument): FlowNode[] {
  const read = useCallback(() => doc.getNodes(), [doc]);
  const subscribe = useCallback((cb: () => void) => doc.onNodesChange(cb), [doc]);
  return useStableCollection(read, subscribe);
}

export function useFlowEdges(doc: FlowDocument): FlowEdge[] {
  const read = useCallback(() => doc.getEdges(), [doc]);
  const subscribe = useCallback((cb: () => void) => doc.onEdgesChange(cb), [doc]);
  return useStableCollection(read, subscribe);
}

/**
 * Derive a value from the node set, re-rendering only when *that value*
 * changes.
 *
 * `useFlowNodes` still wakes for any change to any node — including a pure
 * position change, which most consumers do not care about. A component
 * mounted once per node (see `useSharedAddressWarning`) multiplies that: N
 * instances each re-running their filter every time anybody in the room
 * nudges anything. Selecting narrowly keeps that cost proportional to what the
 * component actually reads.
 *
 * `selector` must be pure and cheap; it runs on every doc change.
 */
export function useFlowNodesSelector<T>(
  doc: FlowDocument,
  selector: (nodes: FlowNode[]) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;

  const [value, setValue] = useState<T>(() => selector(doc.getNodes()));

  useEffect(() => {
    const update = () =>
      setValue((previous) => {
        const next = selectorRef.current(doc.getNodes());
        return isEqualRef.current(previous, next) ? previous : next;
      });

    update();
    return doc.onNodesChange(update);
  }, [doc]);

  return value;
}
