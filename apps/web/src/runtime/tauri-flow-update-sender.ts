import { invokeCommand } from "@/lib/ipc";
import type { FlowUpdate, FlowUpdateSender, SendResult } from "./flow-update-sender";

/** Production `FlowUpdateSender` over the Tauri `flow_update` IPC command. */
export class TauriFlowUpdateSender implements FlowUpdateSender {
  async send(update: FlowUpdate): Promise<SendResult> {
    const response = await invokeCommand({
      type: "flow_update",
      flow: { nodes: update.nodes, edges: update.edges },
      brokers: update.brokers,
      providers: update.providers,
    });
    if (response.success) return { ok: true };
    return { ok: false, error: response.error };
  }
}
