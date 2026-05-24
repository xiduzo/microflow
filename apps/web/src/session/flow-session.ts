import { FlowDocument } from "@microflow/collab";
import { LocalStorageSyncAdapter } from "./local-storage-sync-adapter";
import { WebSocketSyncAdapter, type WebSocketSyncAdapterOptions } from "./websocket-sync-adapter";
import type { SyncAdapter } from "./sync-adapter";

export type FlowMode = "local" | "cloud";

export type FlowSession = {
  readonly flowId: string;
  readonly mode: FlowMode;
  /**
   * True for preview/thumbnail sessions where node components must not
   * write back to the doc. Editing sessions (local + cloud) are always
   * `false`. Consumed by `useNodeControls` to suppress the Leva→Yjs
   * commit effect that would otherwise loop in a read-only surface.
   */
  readonly readOnly: boolean;
  readonly doc: FlowDocument;
  readonly sync: SyncAdapter;
  destroy(): void;
};

export function createLocalSession(): FlowSession {
  const doc = FlowDocument.createEmpty();
  doc.setMeta({ name: "Local Flow", description: "Local development flow" });
  const sync = new LocalStorageSyncAdapter(doc);
  return makeSession("local", "local", doc, sync, false);
}

export type CreateCloudSessionOptions = Omit<WebSocketSyncAdapterOptions, "doc"> & {
  meta?: { name?: string; description?: string };
};

export function createCloudSession(options: CreateCloudSessionOptions): FlowSession {
  const doc = FlowDocument.createEmpty();
  if (options.meta) doc.setMeta(options.meta);
  const sync = new WebSocketSyncAdapter({ ...options, doc });
  return makeSession("cloud", options.flowId, doc, sync, false);
}

export function makeSession(
  mode: FlowMode,
  flowId: string,
  doc: FlowDocument,
  sync: SyncAdapter,
  readOnly: boolean,
): FlowSession {
  let destroyed = false;
  return {
    flowId,
    mode,
    readOnly,
    doc,
    sync,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      sync.destroy();
      doc.destroy();
    },
  };
}
