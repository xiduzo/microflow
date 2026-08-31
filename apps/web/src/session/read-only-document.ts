import type { FlowDocument } from "@microflow/collab";

/**
 * Every `FlowDocument` method that mutates the document. Anything not listed
 * here (getters, observers, `encode`, `clearHistory`, the raw `doc` / `nodes`
 * / `edges` handles) passes through untouched, so incoming remote updates and
 * the Yjs→React read path are unaffected.
 */
export const MUTATORS = new Set<PropertyKey>([
  "addNode",
  "setNode",
  "updateNode",
  "updateNodePosition",
  "updateNodeData",
  "removeNode",
  "deleteNode",
  "addEdge",
  "setEdge",
  "updateEdge",
  "removeEdge",
  "setFlowData",
  "clear",
  "setMeta",
  "undo",
  "redo",
]);

const noop = () => {};

/**
 * Wrap a `FlowDocument` so its mutating methods do nothing.
 *
 * One guard for every write path instead of a `readOnly` check at each call
 * site: node dialogs, import, history and the board-target picker all reach
 * the doc directly, and each new one would otherwise have to remember. The
 * seam is the session — `makeSession` applies this whenever `readOnly` is
 * set, so a Viewer's or a preview's doc simply has no writable surface.
 *
 * `ReactFlowBridge` carries its own `readOnly` flag as well; the two guards
 * are independent on purpose. Since ADR-0019 the bridge writes through
 * `setNode` / `deleteNode` rather than at `doc.nodes` directly, so it passes
 * through this proxy too — but do not rely on that as the only guard.
 *
 * `MUTATORS` is exported so a test can assert it still covers every writing
 * method on `FlowDocument`. A new mutator that is not listed here is a
 * silent hole in Viewer enforcement.
 */
export function readOnlyDocument(doc: FlowDocument): FlowDocument {
  return new Proxy(doc, {
    get(target, prop, receiver) {
      if (MUTATORS.has(prop)) return noop;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
