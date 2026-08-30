import { useNodeId } from "@/components/flow/nodes/_base/node-context";
import { create } from "zustand";

type NodeData<T extends unknown = unknown> = {
  data: Record<string, T>;
  update: (id: string, data: T) => void;
  clear: () => void;
};

/**
 * Values written since the last publish. A running flow can emit hundreds of
 * component events a second — far more than the display can show — and each one
 * used to rebuild the whole `data` record and wake every node's selector.
 * Buffering here collapses a frame's worth of events per node into a single
 * store publish; because the store only ever holds the *latest* value per node,
 * the collapsed frames were never rendered to begin with.
 */
let pending = new Map<string, unknown>();
let frame: number | null = null;

export const useNodeDataStore = create<NodeData>((set) => {
  const flush = () => {
    frame = null;
    if (pending.size === 0) return;
    const batch = pending;
    pending = new Map();
    set((state) => {
      const data = { ...state.data };
      for (const [id, value] of batch) data[id] = value;
      return { data };
    });
  };

  return {
    data: {},
    clear: () => {
      pending.clear();
      set({ data: {} });
    },
    update: (id, data) => {
      pending.set(id, data);
      if (frame !== null) return;
      frame =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(flush)
          : (setTimeout(flush, 16) as unknown as number);
    },
  };
});

export function useNodeValue<T>(defaultValue: T) {
  // This is a dirty hack to get the id of the current node from the context
  // You should never mix react context with a zustand state
  // But ej, there is always an exception to the rule
  const id = useNodeId();
  // Use a direct selector instead of useShallow - useShallow is for object comparison,
  // but node values are typically primitives (numbers, booleans) that need strict equality
  return useNodeDataStore((state) => (state.data[id] as T) ?? defaultValue);
}

export function useNodeHandleValue<T>(handle: string, defaultValue: T) {
  const id = useNodeId();
  return useNodeDataStore((state) => (state.data[`${id}:${handle}`] as T) ?? defaultValue);
}

export function useClearNodeData() {
  return useNodeDataStore((state) => state.clear);
}
