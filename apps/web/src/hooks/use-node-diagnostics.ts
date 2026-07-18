import { useListen } from "@/lib/ipc";
import type { NodeDiagnostic } from "@/lib/firmata/effects-sink";
import { useNodeDiagnosticsStore } from "@/stores/node-diagnostics";

/**
 * Listens to node diagnostics from the Tauri backend and applies them to the
 * same {@link useNodeDiagnosticsStore} the browser wasm reactor writes — so a
 * hardware fault (e.g. an I2C device that never ACKs) surfaces on the node's
 * badge identically on desktop and in the browser. The runtime raises/clears
 * these on a transition, so a `null` message clears the node.
 */
export function useNodeDiagnostics() {
  const apply = useNodeDiagnosticsStore((state) => state.apply);

  useListen<NodeDiagnostic>({
    type: "node-diagnostic",
    handler: ({ payload }) => {
      apply(payload);
    },
  });
}
