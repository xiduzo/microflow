/**
 * The last hop where a node's control edits become CRDT writes.
 *
 * Plain TS so the commit policy is testable without Leva or ReactFlow. The
 * committer owns the behaviours `useNodeControls` used to tangle:
 *
 * - **Write ordering.** `commit` defers through `schedule` (rAF in the app) so
 *   synchronous `forceCommit` calls made from Leva `onChange` handlers land in
 *   the doc first, and the controls commit last. That order is the contract:
 *   declared control keys belong to the controls (their commit wins), while
 *   `forceCommit` owns the keys the controls cannot express. Scheduled
 *   commits coalesce — only the latest control values reach the doc.
 * - **Echo suppression.** `lastKnown` tracks the values the doc and the
 *   controls last agreed on, seeded from the doc at mount. A commit writes
 *   only the keys that differ from it, so opening a node writes nothing, and
 *   the replay of a remote edit into the controls is not written back.
 * - **Pending intent is rebased, not dropped.** A key the user has edited but
 *   not yet flushed is local intent. A doc change landing in that window does
 *   not replay over it (the user's keystroke would vanish from the input), and
 *   the flush then writes only that key — never the stale values of keys the
 *   doc just changed. This is the same rule `ReactFlowBridge` applies to
 *   positions and deletes.
 * - **The readOnly guard.** A read-only session's committer never writes.
 *   The session's `readOnlyDocument` proxy already no-ops every mutator;
 *   this is the cheaper first line, and it spares the rAF churn.
 * - **Field scope.** Writes go through `FlowDocument.updateNodeData`, which
 *   patches only the keys present (ADR-0019's nested per-field merge). A data
 *   field the control schema does not declare — a Function node's `code`, say
 *   — is therefore deliberately *preserved*: a commit never writes or deletes
 *   it, and a reconcile never replays it into the controls.
 */

import { isValueEqual } from "@microflow/collab";

type NodeData = Record<string, unknown>;

/** The one slice of `FlowDocument` a committer needs. */
export interface NodeDataDoc {
  updateNodeData(nodeId: string, data: NodeData): void;
}

export interface NodeDataCommitterOptions {
  doc: NodeDataDoc;
  nodeId: string;
  readOnly: boolean;
  /**
   * What the doc and the controls hold at mount — the baseline every later
   * commit is diffed against. `doc` wins where both have a key; `controls`
   * covers the keys the doc lacks (a control added after the node was
   * created shows its default, and showing a default is not an edit).
   */
  initial: { doc: NodeData; controls: NodeData };
  /** Defer callback for `commit`; rAF in the app, injectable in tests. */
  schedule?: (run: () => void) => void;
}

export function createNodeDataCommitter(options: NodeDataCommitterOptions) {
  const { doc, nodeId, readOnly } = options;
  const schedule = options.schedule ?? ((run: () => void) => requestAnimationFrame(run));

  /** Last values the doc and the controls agreed on, per key. Updated by
   *  every write and every reconcile. */
  let lastKnown: NodeData = { ...options.initial.controls, ...options.initial.doc };
  /** Control values queued for the next flush. */
  let pending: NodeData | null = null;

  /** True when `key` holds an unflushed local edit: queued, and different from
   *  what the doc and the controls last agreed on. */
  const isPendingEdit = (key: string): boolean =>
    pending !== null && key in pending && !isValueEqual(pending[key], lastKnown[key]);

  const write = (values: NodeData) => {
    doc.updateNodeData(nodeId, values);
    lastKnown = { ...lastKnown, ...values };
  };

  const flush = () => {
    const values = pending;
    pending = null;
    if (!values) return;
    // Diffed at flush time, not commit time: a forceCommit or reconcile in
    // between has already moved `lastKnown`, and an echo must not write back.
    // Only the changed keys go out — re-sending an unchanged one would
    // overwrite a peer's concurrent edit to it.
    const changed: NodeData = {};
    let any = false;
    for (const key of Object.keys(values)) {
      if (isValueEqual(values[key], lastKnown[key])) continue;
      changed[key] = values[key];
      any = true;
    }
    if (any) write(changed);
  };

  return {
    /**
     * Queue the current control values for a deferred per-field write.
     * Coalesces: only the values from the most recent call are written, and
     * only the keys among them that changed.
     */
    commit(values: NodeData): void {
      if (readOnly) return;
      const alreadyScheduled = pending !== null;
      pending = values;
      if (!alreadyScheduled) schedule(flush);
    },

    /**
     * The escape hatch behind `setNodeData`: write immediately, ahead of any
     * scheduled commit, for values the controls cannot express (transient
     * `onChange` controls, dialog saves). Same guards, no deferral.
     */
    forceCommit(values: NodeData): void {
      if (readOnly) return;
      write(values);
    },

    /**
     * The doc changed (remote edit, undo/redo, or the echo of our own write).
     * Returns the patch of *declared* keys the controls should replay, or
     * `null` when doc and controls already agree. Keys with a pending local
     * edit are left out — the flush is about to write them. Recording the
     * patch in `lastKnown`, and in the queued values, is what stops the replay
     * (or the stale queue) from being written back.
     */
    reconcile(docData: NodeData, controlValues: NodeData): NodeData | null {
      const patch: NodeData = {};
      let any = false;
      for (const key of Object.keys(controlValues)) {
        if (!(key in docData) || isPendingEdit(key)) continue;
        if (isValueEqual(docData[key], controlValues[key])) continue;
        patch[key] = docData[key];
        any = true;
      }
      if (!any) return null;
      lastKnown = { ...lastKnown, ...patch };
      if (pending) pending = { ...pending, ...patch };
      return patch;
    },
  };
}

export type NodeDataCommitter = ReturnType<typeof createNodeDataCommitter>;
