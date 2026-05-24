import { FlowDocument, type FlowEdge, type FlowNode } from "@microflow/collab";
import { makeSession, type FlowSession } from "./flow-session";
import type { SyncAdapter } from "./sync-adapter";

/**
 * NoOp `SyncAdapter` for read-only previews (thumbnails, template cards).
 * Doesn't persist, doesn't connect, doesn't observe — sitting behind a
 * `FlowSession` whose only job is to satisfy the `useFlowSession()`
 * contract for node components rendered in a non-editable surface.
 */
class NoOpSyncAdapter implements SyncAdapter {
  readonly kind = "local" as const;
  destroy(): void {}
}

/**
 * Build a throwaway `FlowSession` seeded with the given nodes/edges, with
 * no persistence and no sync. The session is marked `readOnly: true` so
 * node components (e.g. `useNodeControls`) suppress write-back effects
 * that would otherwise loop on a read-only surface.
 *
 * Each call constructs a fresh `FlowDocument`; caller is responsible for
 * `destroy()` on unmount.
 */
export function createPreviewSession(
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowSession {
  const doc = FlowDocument.createEmpty();
  doc.setFlowData(nodes, edges);
  doc.clearHistory();
  return makeSession("local", "__preview__", doc, new NoOpSyncAdapter(), true);
}
