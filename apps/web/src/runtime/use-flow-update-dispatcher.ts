import { useEffect, useState } from "react";
import { toast } from "sonner";
import { NODE_CATALOG } from "@/nodes/catalog.generated";
import { onHostSnapshotChange, readHostSnapshot } from "@/cloud/cloud-capabilities";
import { DebounceScheduler, FlowUpdateDispatcher } from "./flow-update-dispatcher";
import { TauriFlowUpdateSender } from "./tauri-flow-update-sender";
import { WasmFlowUpdateSender } from "./wasm-flow-update-sender";
import { isDesktop } from "@/platform/platform";
import type { FlowSession } from "@/session";

const DEBOUNCE_MS = 500;
/** Never let the runtime go longer than this without the current flow, however
 *  busy the room is. See `DebounceScheduler`. */
const DEBOUNCE_MAX_WAIT_MS = 1500;
/** A failed send is retried this long after it failed… */
const RETRY_DELAY_MS = 2000;
/** …until this many consecutive sends have failed; then the user is told. */
const MAX_SEND_ATTEMPTS = 4;

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
        NODE_CATALOG,
        {
          scheduler: new DebounceScheduler(RETRY_DELAY_MS, RETRY_DELAY_MS),
          maxAttempts: MAX_SEND_ATTEMPTS,
          onGiveUp: (error) => {
            toast.error(`Your latest flow changes did not reach the runtime: ${error}`);
          },
        },
      ),
  );

  useEffect(() => onHostSnapshotChange(() => dispatcher.refresh()), [dispatcher]);
  useEffect(() => () => dispatcher.destroy(), [dispatcher]);
}
