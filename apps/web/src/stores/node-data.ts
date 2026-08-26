import { useNodeId } from "@/components/flow/nodes/_base/node-context";
import { useCallback, useRef, useSyncExternalStore } from "react";

/**
 * Latest runtime value per key — a node id, or `id:handle` for a side-channel
 * such as the LLM `thinking` flag.
 *
 * Values live in a plain `Map` with one listener set per key: an Emission
 * writes one entry and wakes only the node that reads it, so the cost of a
 * write is independent of how many nodes the flow has.
 *
 * Waking is deferred to the next frame. A running flow can emit hundreds of
 * component events a second — far more than the display can show — and each
 * one arrives in its own task (one Tauri IPC callback on the desktop, one
 * `Effects` per `feedBytes` return in the browser), so React has nothing to
 * batch them with. Buffering the *keys* collapses a frame's worth of events
 * per node into a single wake-up; the value itself is written straight away,
 * so the frame publishes the newest one and never a stale intermediate.
 */
const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

/** Keys written since the last publish. */
const pending = new Set<string>();
let frame: number | null = null;

function notify(id: string) {
  const subscribers = listeners.get(id);
  if (!subscribers) return;
  for (const listener of subscribers) listener();
}

function flush() {
  frame = null;
  if (pending.size === 0) return;
  const batch = [...pending];
  pending.clear();
  for (const id of batch) notify(id);
}

/** Drop a scheduled publish. A stale callback that still fires finds `pending`
 *  empty and does nothing; what matters is that the next write can re-arm. */
function cancel() {
  if (frame === null) return;
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
  else clearTimeout(frame as unknown as ReturnType<typeof setTimeout>);
  frame = null;
}

function schedule(id: string) {
  pending.add(id);
  if (frame !== null) return;
  frame =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(flush)
      : (setTimeout(flush, 16) as unknown as number);
}

function subscribe(id: string, listener: () => void): () => void {
  let subscribers = listeners.get(id);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(id, subscribers);
  }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(id);
  };
}

export const nodeDataStore = {
  /** Latest value for one key, or `undefined`. Written straight away, so this
   *  reads ahead of the frame that publishes it to React. */
  get(id: string): unknown {
    return values.get(id);
  },
  /** Wake `listener` when `id` is published. The same subscription
   *  {@link useNodeValue} uses. */
  subscribe,
  update(id: string, value: unknown) {
    values.set(id, value);
    schedule(id);
  },
  clear() {
    values.clear();
    pending.clear();
    cancel();
    for (const id of [...listeners.keys()]) notify(id);
  },
};

function useValue<T>(id: string, defaultValue: T): T {
  // Pinned on the first render: callers pass fresh object literals (an RGBA
  // colour, a pixel grid) and a snapshot must keep a stable identity.
  const fallback = useRef(defaultValue);
  const value = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(id, listener), [id]),
    () => values.get(id),
    () => undefined,
  );
  return (value as T | null | undefined) ?? fallback.current;
}

export function useNodeValue<T>(defaultValue: T) {
  // This is a dirty hack to get the id of the current node from the context
  // You should never mix react context with a zustand state
  // But ej, there is always an exception to the rule
  const id = useNodeId();
  return useValue(id, defaultValue);
}

export function useNodeHandleValue<T>(handle: string, defaultValue: T) {
  const id = useNodeId();
  return useValue(`${id}:${handle}`, defaultValue);
}

export function useClearNodeData() {
  return nodeDataStore.clear;
}
