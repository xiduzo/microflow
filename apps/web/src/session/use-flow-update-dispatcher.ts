import { useEffect, useState } from "react";
import { NODE_REGISTRY } from "@/components/flow/nodes/_REGISTRY";
import { readHostSnapshot } from "./cloud-capabilities";
import { DebounceScheduler, FlowUpdateDispatcher } from "./flow-update-dispatcher";
import { TauriFlowUpdateSender } from "./tauri-flow-update-sender";
import { WasmFlowUpdateSender } from "./wasm-flow-update-sender";
import { isDesktop } from "@/lib/platform";
import type { FlowSession } from "./flow-session";

const DEBOUNCE_MS = 500;
/** Never let the runtime go longer than this without the current flow, however
 *  busy the room is. See `DebounceScheduler`. */
const DEBOUNCE_MAX_WAIT_MS = 1500;

/**
 * Mount one `FlowUpdateDispatcher` for the active `FlowSession`. Caller is
 * responsible for `isDesktop()` gating — the dispatcher itself contains
 * no platform branches, so it can run anywhere a `TauriFlowUpdateSender`
 * is wired up.
 */
export function useFlowUpdateDispatcher(session: FlowSession): void {
  const [dispatcher] = useState(
    () =>
      new FlowUpdateDispatcher(
        session,
        readHostSnapshot,
        // Desktop drives the native runtime over Tauri IPC; the browser drives
        // the in-browser wasm runtime via the board-controller.
        isDesktop() ? new TauriFlowUpdateSender() : new WasmFlowUpdateSender(),
        new DebounceScheduler(DEBOUNCE_MS, DEBOUNCE_MAX_WAIT_MS),
        NODE_REGISTRY,
      ),
  );

  useEffect(() => () => dispatcher.destroy(), [dispatcher]);
}
