import type { FlowEdge, FlowNode } from "@microflow/collab";
import { IndexeddbSyncAdapter } from "./indexeddb-sync-adapter";
import { acquireLocalSession, releaseSession } from "./session-registry";

/**
 * Read/write access to the local flow for surfaces outside the editor
 * (templates, the overview thumbnail, import-without-account).
 *
 * The local flow lives in the Yjs document persisted by
 * `IndexeddbSyncAdapter` — writing a JSON snapshot to `localStorage` has no
 * effect on it. Both helpers go through the session registry so a session the
 * editor already holds sees the write immediately.
 */
async function withLocalFlow<T>(fn: (doc: ReturnType<typeof acquireLocalSession>["doc"]) => T) {
  const session = acquireLocalSession();
  try {
    if (session.sync instanceof IndexeddbSyncAdapter) await session.sync.whenSynced;
    return fn(session.doc);
  } finally {
    releaseSession("local");
  }
}

/** Replaces the local flow's contents. */
export function saveLocalFlow(nodes: FlowNode[], edges: FlowEdge[]): Promise<void> {
  return withLocalFlow((doc) => doc.setFlowData(nodes, edges));
}

/** Current local flow contents, for previews outside the editor. */
export function loadLocalFlow(): Promise<{ nodes: FlowNode[]; edges: FlowEdge[] }> {
  return withLocalFlow((doc) => doc.getFlowData());
}
