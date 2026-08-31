import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "@/lib/platform";
import { dispatchToNode } from "./board-controller";

/**
 * Deliver one host-originated value to a node's port, whichever host we are in:
 * the desktop actor's `component_call` IPC, or straight into the browser's wasm
 * runtime. The runtime owns every bit of routing from there — this only picks
 * the door.
 *
 * Used by the parts of the UI that act like a wire: a settings-panel play
 * button, an audio track reporting that it finished.
 */
export function dispatchPort(nodeId: string, port: string, value: unknown): void {
  if (isDesktop()) {
    void invoke("component_call", { componentId: nodeId, method: port, args: value }).catch(
      (error: unknown) => {
        console.error(`[dispatch-port] ${nodeId}.${port} failed:`, error);
      },
    );
    return;
  }
  dispatchToNode(nodeId, port, value);
}
