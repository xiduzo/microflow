// Browser counterpart to TauriFlowUpdateSender: instead of an IPC round-trip to
// a native runtime, it drives the in-browser wasm flow runtime via the
// board-controller. Satisfies the same `FlowUpdateSender` seam, so the
// platform-neutral `FlowUpdateDispatcher` is reused wholesale.
//
// Pure transport: `update.nodes`/`update.edges` are already the core
// `FlowUpdate` shape (normalised once in `buildFlowUpdate`). `brokers` /
// `providers` are dropped — the browser resolves cloud config live from its
// stores (`CloudDeps` in board-controller.ts), so only the flow crosses.

import { pushFlowUpdate } from "@/lib/firmata/board-controller";
import type { FlowUpdate, FlowUpdateSender, SendResult } from "./flow-update-sender";

export class WasmFlowUpdateSender implements FlowUpdateSender {
  async send(update: FlowUpdate): Promise<SendResult> {
    pushFlowUpdate({ nodes: update.nodes, edges: update.edges });
    return { ok: true };
  }
}
