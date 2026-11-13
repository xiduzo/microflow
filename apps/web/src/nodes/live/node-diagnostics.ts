import { useNodeId } from "@/nodes/_base/node-context";
import type { DiagnosticOrigin } from "@/lib/bindings/DiagnosticOrigin";
import type { NodeDiagnostic } from "@/runtime/effects-sink";
import { create } from "zustand";

/** A node's live runtime health, fed by the runtime `node_diagnostics` effect
 *  (browser reactor + desktop `node-diagnostic` Tauri event). Distinct from
 *  {@link useNodeDataStore} — that carries edge *values*; this carries a node's
 *  faults, rendered on the `NodeContainer` error/warning badge.
 *
 *  Diagnostics arrive from two origins: the node about itself (an I2C NACK) and
 *  the runtime about the node (failed build, rejected input, paused loop). Each
 *  is kept apart, so a `null` message clears only its own origin — the runtime
 *  clearing a rejected input can never wipe a fault the node will not
 *  re-report. The badge shows the most severe of the two. */
export type Diagnostic = { level: "warning" | "error"; message: string };

type ByOrigin = Partial<Record<DiagnosticOrigin, Diagnostic>>;

type NodeDiagnosticsState = {
  /** What each node's badge shows: the most severe diagnostic of any origin. */
  diagnostics: Record<string, Diagnostic>;
  /** Every live diagnostic, per node and origin. */
  byOrigin: Record<string, ByOrigin>;
  apply: (diagnostic: NodeDiagnostic) => void;
  clear: () => void;
};

/** The most severe diagnostic of a node's origins. On a tie the runtime's wins:
 *  it is about whether the node runs at all. */
export function mostSevere(origins: ByOrigin): Diagnostic | undefined {
  const { node, runtime } = origins;
  if (!node) return runtime;
  if (!runtime) return node;
  if (node.level === "error" && runtime.level === "warning") return node;
  return runtime;
}

export const useNodeDiagnosticsStore = create<NodeDiagnosticsState>((set) => ({
  diagnostics: {},
  byOrigin: {},
  clear: () => {
    set({ diagnostics: {}, byOrigin: {} });
  },
  apply: ({ node, level, message, origin }) => {
    set((state) => {
      const origins: ByOrigin = { ...state.byOrigin[node] };
      if (message === null) {
        delete origins[origin];
      } else {
        origins[origin] = { level, message };
      }

      const byOrigin = { ...state.byOrigin };
      const diagnostics = { ...state.diagnostics };
      const shown = mostSevere(origins);
      if (shown === undefined) {
        delete byOrigin[node];
        delete diagnostics[node];
      } else {
        byOrigin[node] = origins;
        diagnostics[node] = shown;
      }
      return { diagnostics, byOrigin };
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
