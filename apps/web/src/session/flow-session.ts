import { FlowDocument } from "@microflow/collab";
import { LocalStorageSyncAdapter } from "./local-storage-sync-adapter";
import { WebSocketSyncAdapter, type WebSocketSyncAdapterOptions } from "./websocket-sync-adapter";
import { readOnlyDocument } from "./read-only-document";
import type { SyncAdapter } from "./sync-adapter";

export type FlowMode = "local" | "cloud";

/**
 * The access level the local user has on this session's flow — mirrors the
 * server's Flow Role. `null` for surfaces where the notion doesn't apply
 * (local flows, previews); those are governed by `readOnly` alone.
 */
export type FlowRole = "viewer" | "editor" | "owner";

export type FlowSession = {
  readonly flowId: string;
  readonly mode: FlowMode;
  /** The local user's Flow Role on a cloud flow; `null` otherwise. */
  readonly role: FlowRole | null;
  /**
   * True when node components must not write back to the doc. Two sources:
   * preview/thumbnail surfaces, and a cloud flow the local user only has
   * Viewer access to — the Yjs room drops a Viewer's writes, so letting the
   * editor accept them locally would silently diverge the two documents.
   *
   * Consumed by `useNodeControls` (suppresses the Leva→Yjs commit effect),
   * `ReactFlowBridge` (suppresses structural writes) and the canvas
   * (disables dragging, connecting and deleting).
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
  return makeSession("local", "local", doc, sync, false, null);
}

export type CreateCloudSessionOptions = Omit<WebSocketSyncAdapterOptions, "doc"> & {
  meta?: { name?: string; description?: string };
  /** The local user's Flow Role, from `flow.get`. Viewers get a read-only session. */
  role?: FlowRole;
};

export function createCloudSession(options: CreateCloudSessionOptions): FlowSession {
  const doc = FlowDocument.createEmpty();
  if (options.meta) doc.setMeta(options.meta);
  const sync = new WebSocketSyncAdapter({ ...options, doc });
  const role = options.role ?? null;
  return makeSession("cloud", options.flowId, doc, sync, role === "viewer", role);
}

export function makeSession(
  mode: FlowMode,
  flowId: string,
  doc: FlowDocument,
  sync: SyncAdapter,
  readOnly: boolean,
  role: FlowRole | null = null,
): FlowSession {
  let destroyed = false;
  return {
    flowId,
    mode,
    role,
    readOnly,
    // One write-guard for every call site that reaches the doc directly.
    doc: readOnly ? readOnlyDocument(doc) : doc,
    sync,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      sync.destroy();
      doc.destroy();
    },
  };
}
