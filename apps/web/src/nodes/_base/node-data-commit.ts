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
 *   controls last agreed on. A commit whose values all match it is dropped
 *   (no write-back loop after a remote edit is replayed into the controls),
 *   and a reconcile whose doc data matches it returns nothing (the echo of
 *   our own write does not stomp the controls while the user is typing).
 * - **The readOnly guard.** A read-only session's committer never writes.
 *   The session's `readOnlyDocument` proxy already no-ops every mutator;
 *   this is the cheaper first line, and it spares the rAF churn.
 * - **Field scope.** Writes go through `FlowDocument.updateNodeData`, which
 *   patches only the keys present (ADR-0019's nested per-field merge). A data
 *   field the control schema does not declare — a Function node's `code`, say
 *   — is therefore deliberately *preserved*: a commit never writes or deletes
 *   it, and a reconcile never replays it into the controls.
 */

type NodeData = Record<string, unknown>;

/** The one slice of `FlowDocument` a committer needs. */
export interface NodeDataDoc {
  updateNodeData(nodeId: string, data: NodeData): void;
}

export interface NodeDataCommitterOptions {
  doc: NodeDataDoc;
  nodeId: string;
  readOnly: boolean;
  /** Defer callback for `commit`; rAF in the app, injectable in tests. */
  schedule?: (run: () => void) => void;
}

/** Mirror of `packages/collab/src/schema.ts` `isValueEqual` (not exported
 *  there): value equality for the JSON-ish values a Flow doc holds. Key order
 *  is irrelevant; `undefined` is a value, not an absent key. */
function isValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => isValueEqual(item, b[i]));
  }
  const ao = a as NodeData;
  const bo = b as NodeData;
  const aKeys = Object.keys(ao);
  if (aKeys.length !== Object.keys(bo).length) return false;
  return aKeys.every((key) => key in bo && isValueEqual(ao[key], bo[key]));
}

export function createNodeDataCommitter(options: NodeDataCommitterOptions) {
  const { doc, nodeId, readOnly } = options;
  const schedule = options.schedule ?? ((run: () => void) => requestAnimationFrame(run));

  /** Last values the doc and the controls agreed on, per declared key.
   *  Updated by every write and every reconcile; `null` until the first. */
  let lastKnown: NodeData | null = null;
  let pending: NodeData | null = null;

  const write = (values: NodeData) => {
    doc.updateNodeData(nodeId, values);
    lastKnown = { ...lastKnown, ...values };
  };

  const flush = () => {
    const values = pending;
    pending = null;
    if (!values) return;
    // Compared at flush time, not commit time: a forceCommit or reconcile in
    // between has already moved `lastKnown`, and an echo must not write back.
    if (lastKnown !== null && Object.keys(values).every((key) => isValueEqual(values[key], lastKnown![key]))) {
      return;
    }
    write(values);
  };

  return {
    /**
     * Queue the current control values for a deferred per-field write.
     * Coalesces: only the values from the most recent call are written.
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
     * `null` when doc and controls already agree. Recording the patch in
     * `lastKnown` is what suppresses the follow-up commit of the replay.
     */
    reconcile(docData: NodeData, controlValues: NodeData): NodeData | null {
      const basis = lastKnown ?? controlValues;
      const patch: NodeData = {};
      for (const key of Object.keys(controlValues)) {
        if (key in docData && !isValueEqual(docData[key], basis[key])) {
          patch[key] = docData[key];
        }
      }
      if (Object.keys(patch).length === 0) return null;
      lastKnown = { ...basis, ...patch };
      return patch;
    },
  };
}

export type NodeDataCommitter = ReturnType<typeof createNodeDataCommitter>;
