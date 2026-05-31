// Browser counterpart to TauriFlowUpdateSender: instead of an IPC round-trip to
// a native runtime, it drives the in-browser wasm flow runtime via the
// board-controller. Satisfies the same `FlowUpdateSender` seam, so the
// platform-neutral `FlowUpdateDispatcher` is reused wholesale.

import { pushFlowUpdate } from "@/lib/firmata/board-controller";
import type { FlowUpdate, FlowUpdateSender, SendResult } from "./flow-update-sender";

export class WasmFlowUpdateSender implements FlowUpdateSender {
  async send(update: FlowUpdate): Promise<SendResult> {
    // Map to the core `FlowUpdate` shape (`microflow_core::flow`). brokers /
    // providers are cloud config — not part of the phase-1 browser runtime.
    // Core `FlowEdge` requires non-optional handles, so default them.
    const core = {
      nodes: update.nodes.map((node) => ({
        id: node.id,
        type: node.type ?? null,
        data: node.data,
        position: node.position,
      })),
      edges: update.edges.map((edge) => ({
        id: edge.id ?? null,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? "",
        targetHandle: edge.targetHandle ?? "",
      })),
    };
    pushFlowUpdate(JSON.stringify(core));
    return { ok: true };
  }
}
