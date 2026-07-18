import { useNodeId } from "@/components/flow/nodes/_base/_base";
import type { NodeDiagnostic } from "@/lib/firmata/effects-sink";
import { create } from "zustand";

/** A node's live runtime health, fed by the runtime `node_diagnostics` effect
 *  (browser reactor + desktop `node-diagnostic` Tauri event). Distinct from
 *  {@link useNodeDataStore} — that carries edge *values*; this carries a node's
 *  self-reported fault, rendered on the existing `NodeContainer` error/warning
 *  badge. A `null` message clears the node (recovery). */
type Diagnostic = { level: "warning" | "error"; message: string };

type NodeDiagnosticsState = {
  diagnostics: Record<string, Diagnostic>;
  apply: (diagnostic: NodeDiagnostic) => void;
  clear: () => void;
};

export const useNodeDiagnosticsStore = create<NodeDiagnosticsState>((set) => ({
  diagnostics: {},
  clear: () => {
    set({ diagnostics: {} });
  },
  apply: ({ node, level, message }) => {
    set((state) => {
      const next = { ...state.diagnostics };
      if (message === null) {
        delete next[node];
      } else {
        next[node] = { level, message };
      }
      return { diagnostics: next };
    });
  },
}));

/** The current diagnostic for the node in context, or `undefined` if healthy. */
export function useNodeDiagnostic(): Diagnostic | undefined {
  const id = useNodeId();
  return useNodeDiagnosticsStore((state) => state.diagnostics[id]);
}

export function useClearNodeDiagnostics() {
  return useNodeDiagnosticsStore((state) => state.clear);
}
