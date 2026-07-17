import type { FlowUpdate as CoreFlowUpdate } from "@/lib/bindings/FlowUpdate";

export type DispatchedBroker = {
  id: string;
  name: string;
  url: string;
  username?: string;
  password?: string;
};

export type DispatchedProvider = {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
};

/**
 * Payload sent to either runtime host. `nodes`/`edges` are the core
 * `microflow_core::flow::FlowUpdate` shape (ts-rs binding) — normalised once in
 * `buildFlowUpdate`, so neither sender re-maps the flow. `brokers`/`providers`
 * are desktop-only infra config; the browser resolves cloud config live from
 * its stores (`CloudDeps`).
 */
export type FlowUpdate = CoreFlowUpdate & {
  brokers: DispatchedBroker[];
  providers: DispatchedProvider[];
};

export type SendResult = { ok: true } | { ok: false; error: string };

/**
 * Transport abstraction for `FlowUpdate` payloads.
 *
 * Production: `TauriFlowUpdateSender` (lives in its own file so tests can
 * import `RecordingFlowUpdateSender` without pulling Tauri / env into the
 * bundle). Mirrors the
 * [`RemoteSyncAdapter` / `RecordingSyncAdapter`](./sync-adapter.ts)
 * production-vs-recording discipline from ADR-0002.
 */
export interface FlowUpdateSender {
  send(update: FlowUpdate): Promise<SendResult>;
}

export class RecordingFlowUpdateSender implements FlowUpdateSender {
  readonly sent: FlowUpdate[] = [];
  private scriptedErrors: string[] = [];

  /** Push a scripted error onto the queue; the next `send(...)` will fail. */
  scriptError(message: string): void {
    this.scriptedErrors.push(message);
  }

  async send(update: FlowUpdate): Promise<SendResult> {
    this.sent.push(update);
    const error = this.scriptedErrors.shift();
    if (error) return { ok: false, error };
    return { ok: true };
  }
}
