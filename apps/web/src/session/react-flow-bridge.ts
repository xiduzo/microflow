import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import type { FlowDocument, FlowEdge, FlowNode } from "@microflow/collab";

/** Element-wise reference equality. Meaningful only because the merges above
 *  preserve identity for unchanged entries. */
function sameMembers<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Bidirectional bridge between a `FlowDocument` (Y.Doc CRDT) and the
 * ReactFlow change protocol. Owns five named invariants:
 *
 * 1. **Classification** — `classifyNodeChange` / `classifyEdgeChange` decide
 *    whether a ReactFlow change is structural (flows to Y.Doc) or ephemeral
 *    (local React state only).
 * 2. **Loop guard** — `isFlushingToDoc` blocks the Yjs→React merge during
 *    our own synchronous `transact("local")`, so our outgoing writes don't
 *    immediately echo back into our snapshot.
 * 3. **Local-UI-state preservation** — `mergeYjsIntoSnapshot` carries
 *    `selected` / `dragging` from the current snapshot onto incoming Yjs
 *    nodes; those fields never round-trip through Y.Doc.
 * 4. **Diff** — `nodeNeedsWrite` skips Y.Doc writes when position +
 *    dimensions are unchanged, avoiding redundant CRDT updates.
 * 5. **RAF batching** — multiple structural changes in one frame coalesce
 *    into one `transact("local")` and therefore one UndoManager entry.
 *
 * Constructed once per `FlowDocument`. The hook `useReactFlowBridge`
 * owns construction + teardown; route layouts may also construct one
 * directly in tests.
 *
 * Convergence (across clients) is the Y.Doc's responsibility, not the
 * bridge's — the bridge only must not break it. Specifically: writes are
 * tagged with origin `"local"` so the `UndoManager` tracks them
 * symmetrically; remote-origin updates flow through `mergeYjsIntoSnapshot`
 * unchanged.
 */
export class ReactFlowBridge {
  // -------------------------------------------------------------------------
  // Static classification rules (pure)
  // -------------------------------------------------------------------------

  static classifyNodeChange(c: NodeChange): "structural" | "ephemeral" {
    switch (c.type) {
      case "add":
      case "remove":
      case "dimensions":
      case "replace":
        return "structural";
      case "position":
        return c.dragging ? "ephemeral" : "structural";
      case "select":
        return "ephemeral";
      default:
        return "ephemeral";
    }
  }

  static classifyEdgeChange(c: EdgeChange): "structural" | "ephemeral" {
    switch (c.type) {
      case "add":
      case "remove":
      case "replace":
        return "structural";
      case "select":
        return "ephemeral";
      default:
        return "ephemeral";
    }
  }

  /**
   * Whether a node differs from what the Y.Doc holds.
   *
   * Compares everything the document owns — geometry, `type` and `data` — not
   * just position and size. `data` is compared by reference, which is exact
   * here rather than approximate: `FlowDocument` replaces the whole node
   * object on every write, and Yjs hands back the same stored reference for a
   * key nobody touched. A differing reference therefore means a real write, and
   * an identical one means no write happened.
   *
   * The narrower position-and-size check this replaces silently dropped any
   * data change routed through `applyNodeChanges` (a ReactFlow `replace`),
   * because such a change is classified structural and then diffed away.
   */
  static nodeNeedsWrite(local: FlowNode, yjs: FlowNode | undefined): boolean {
    if (!yjs) return true;
    return (
      local.position.x !== yjs.position.x ||
      local.position.y !== yjs.position.y ||
      local.width !== yjs.width ||
      local.height !== yjs.height ||
      local.type !== yjs.type ||
      local.data !== yjs.data
    );
  }

  /** Edge equivalent — endpoints, handles and type are all document state. */
  static edgeNeedsWrite(local: FlowEdge, yjs: FlowEdge | undefined): boolean {
    if (!yjs) return true;
    return (
      local.source !== yjs.source ||
      local.target !== yjs.target ||
      local.sourceHandle !== yjs.sourceHandle ||
      local.targetHandle !== yjs.targetHandle ||
      local.type !== yjs.type
    );
  }

  /**
   * Whether an incoming Yjs node is equivalent to the one already in the
   * React snapshot, ignoring the local-only fields. Drives identity
   * preservation in `mergeYjsIntoSnapshot`.
   */
  private static nodeMatchesSnapshot(local: FlowNode, incoming: FlowNode): boolean {
    return (
      local.position.x === incoming.position.x &&
      local.position.y === incoming.position.y &&
      local.width === incoming.width &&
      local.height === incoming.height &&
      local.type === incoming.type &&
      local.data === incoming.data
    );
  }

  private static edgeMatchesSnapshot(local: FlowEdge, incoming: FlowEdge): boolean {
    return (
      local.source === incoming.source &&
      local.target === incoming.target &&
      local.sourceHandle === incoming.sourceHandle &&
      local.targetHandle === incoming.targetHandle &&
      local.type === incoming.type
    );
  }

  // -------------------------------------------------------------------------
  // Instance state
  // -------------------------------------------------------------------------

  readonly doc: FlowDocument;

  private currentSnapshot: { nodes: FlowNode[]; edges: FlowEdge[] };
  private readonly listeners = new Set<() => void>();
  private readonly unobserveNodes: () => void;
  private readonly unobserveEdges: () => void;

  private pendingFrame: number | null = null;
  private hasPendingNodeWrite = false;
  private hasPendingEdgeWrite = false;

  /**
   * Ids touched since the last flush, so the write walks only what changed
   * instead of the whole flow. `null` means "we could not attribute every
   * change to an id" — a full sweep is then the only correct option. The
   * fallback keeps this an optimisation rather than a new invariant.
   */
  private dirtyNodeIds: Set<string> | null = new Set();
  private dirtyEdgeIds: Set<string> | null = new Set();

  /** True only inside our own `transact("local")` to suppress echo. */
  private isFlushingToDoc = false;
  private destroyed = false;

  /**
   * When true, structural changes update the React snapshot but never reach
   * the Y.Doc. The backstop behind the canvas's own read-only props: a
   * Viewer's writes are dropped by the Yjs room, so accepting them locally
   * would diverge the two documents in silence.
   */
  readonly readOnly: boolean;

  constructor(doc: FlowDocument, options: { readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly ?? false;
    this.doc = doc;
    this.currentSnapshot = { nodes: doc.getNodes(), edges: doc.getEdges() };
    this.unobserveNodes = doc.onNodesChange(this.handleYjsNodesChange);
    this.unobserveEdges = doc.onEdgesChange(this.handleYjsEdgesChange);
  }

  // -------------------------------------------------------------------------
  // External-store contract (useSyncExternalStore)
  // -------------------------------------------------------------------------

  /** Stable reference between mutations; new reference on every change. */
  getSnapshot = (): { nodes: FlowNode[]; edges: FlowEdge[] } => this.currentSnapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // -------------------------------------------------------------------------
  // React → Yjs
  // -------------------------------------------------------------------------

  applyNodeChanges(changes: NodeChange[]): void {
    if (this.destroyed) return;
    const next = applyNodeChanges(changes, this.currentSnapshot.nodes) as FlowNode[];
    this.setSnapshot({ ...this.currentSnapshot, nodes: next });
    if (this.readOnly) return;

    const structural = changes.filter(
      (c) => ReactFlowBridge.classifyNodeChange(c) === "structural",
    );
    if (structural.length === 0) return;

    this.hasPendingNodeWrite = true;
    this.trackDirty("node", structural);
    this.scheduleFlush();
  }

  applyEdgeChanges(changes: EdgeChange[]): void {
    if (this.destroyed) return;
    const next = applyEdgeChanges(changes, this.currentSnapshot.edges) as FlowEdge[];
    this.setSnapshot({ ...this.currentSnapshot, edges: next });
    if (this.readOnly) return;

    const structural = changes.filter(
      (c) => ReactFlowBridge.classifyEdgeChange(c) === "structural",
    );
    if (structural.length === 0) return;

    this.hasPendingEdgeWrite = true;
    this.trackDirty("edge", structural);
    this.scheduleFlush();
  }

  /**
   * Record which ids a batch of structural changes touched.
   *
   * Any change we cannot pin to an id collapses the set to `null`, which the
   * flush reads as "sweep everything". Being wrong here would drop a write, so
   * the unknown case degrades to the previous full-scan behaviour rather than
   * guessing.
   */
  private trackDirty(kind: "node" | "edge", changes: Array<NodeChange | EdgeChange>): void {
    const current = kind === "node" ? this.dirtyNodeIds : this.dirtyEdgeIds;
    if (current === null) return;

    for (const change of changes) {
      const id =
        "id" in change && typeof change.id === "string"
          ? change.id
          : "item" in change && change.item && typeof change.item.id === "string"
            ? change.item.id
            : null;

      if (id === null) {
        if (kind === "node") this.dirtyNodeIds = null;
        else this.dirtyEdgeIds = null;
        return;
      }
      current.add(id);
    }
  }

  /** Synchronously flush any pending structural writes. Public for tests
   * and callers that need a write barrier (e.g. before navigation). */
  flush(): void {
    if (this.pendingFrame !== null) {
      cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = null;
    }
    const writeNodes = this.hasPendingNodeWrite;
    const writeEdges = this.hasPendingEdgeWrite;
    if (!writeNodes && !writeEdges) return;
    this.hasPendingNodeWrite = false;
    this.hasPendingEdgeWrite = false;

    const dirtyNodes = this.dirtyNodeIds;
    const dirtyEdges = this.dirtyEdgeIds;
    this.dirtyNodeIds = new Set();
    this.dirtyEdgeIds = new Set();

    this.isFlushingToDoc = true;
    try {
      this.doc.doc.transact(() => {
        if (writeNodes) this.writeNodesToDoc(this.currentSnapshot.nodes, dirtyNodes);
        if (writeEdges) this.writeEdgesToDoc(this.currentSnapshot.edges, dirtyEdges);
      }, "local");
    } finally {
      this.isFlushingToDoc = false;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  destroy(): void {
    if (this.destroyed) return;

    // Flush before tearing down. Structural writes are deferred by one frame,
    // so unmounting within that frame — navigating away right after moving a
    // node — silently dropped the edit.
    this.flush();

    this.destroyed = true;
    this.unobserveNodes();
    this.unobserveEdges();
    if (this.pendingFrame !== null) {
      cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = null;
    }
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Yjs → React
  // -------------------------------------------------------------------------

  private handleYjsNodesChange = (): void => {
    if (this.isFlushingToDoc || this.destroyed) return;
    const merged = ReactFlowBridge.mergeYjsIntoSnapshot(
      this.doc.getNodes(),
      this.currentSnapshot.nodes,
    );
    // With identity preserved, an update that changes nothing we render
    // produces an element-wise identical array. Publishing it anyway would
    // hand React a new snapshot object and re-render for nothing.
    if (sameMembers(merged, this.currentSnapshot.nodes)) return;
    this.setSnapshot({ ...this.currentSnapshot, nodes: merged });
  };

  private handleYjsEdgesChange = (): void => {
    if (this.isFlushingToDoc || this.destroyed) return;
    const merged = ReactFlowBridge.mergeEdgesYjsIntoSnapshot(
      this.doc.getEdges(),
      this.currentSnapshot.edges,
    );
    if (sameMembers(merged, this.currentSnapshot.edges)) return;
    this.setSnapshot({ ...this.currentSnapshot, edges: merged });
  };

  /**
   * Merge an incoming Y.Doc snapshot over the current React snapshot,
   * preserving local-only fields (`selected`, `dragging`).
   *
   * **Object identity is the point.** ReactFlow memoizes each node's render on
   * the identity of its node object, so returning a fresh object for every
   * node — which the obvious `yjsNodes.map(n => ({...n}))` does — re-renders
   * the entire canvas every time any peer touches any single node. In a room
   * with several active contributors that is the dominant cost in the editor.
   *
   * So an unchanged node returns *the existing reference*. Only nodes that
   * actually differ get a new object.
   */
  static mergeYjsIntoSnapshot(yjsNodes: FlowNode[], currentLocal: FlowNode[]): FlowNode[] {
    const localMap = new Map(currentLocal.map((n) => [n.id, n]));
    return yjsNodes.map((yjsNode) => {
      const local = localMap.get(yjsNode.id);
      if (local && ReactFlowBridge.nodeMatchesSnapshot(local, yjsNode)) return local;
      return {
        ...yjsNode,
        selected: local?.selected,
        dragging: local?.dragging,
      };
    });
  }

  /** Edge equivalent — only `selected` is local-only. Same identity rule. */
  static mergeEdgesYjsIntoSnapshot(yjsEdges: FlowEdge[], currentLocal: FlowEdge[]): FlowEdge[] {
    const localMap = new Map(currentLocal.map((e) => [e.id, e]));
    return yjsEdges.map((yjsEdge) => {
      const local = localMap.get(yjsEdge.id);
      if (local && ReactFlowBridge.edgeMatchesSnapshot(local, yjsEdge)) return local;
      return { ...yjsEdge, selected: local?.selected };
    });
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private setSnapshot(next: { nodes: FlowNode[]; edges: FlowEdge[] }): void {
    this.currentSnapshot = next;
    for (const l of this.listeners) l();
  }

  private scheduleFlush(): void {
    if (this.pendingFrame !== null) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = null;
      this.flush();
    });
  }

  /**
   * Write the node set to the Y.Doc.
   *
   * When `dirty` is a set, only those ids are considered — dragging one node
   * in a 300-node flow then costs one map lookup rather than three passes over
   * the whole flow, every frame. `null` means the change batch contained
   * something we could not attribute, so fall back to the full sweep.
   */
  private writeNodesToDoc(localNodes: FlowNode[], dirty: Set<string> | null): void {
    const yMap = this.doc.nodes;

    if (dirty) {
      const byId = new Map(localNodes.map((n) => [n.id, n]));
      for (const id of dirty) {
        const node = byId.get(id);
        if (!node) {
          yMap.delete(id);
          continue;
        }
        if (!ReactFlowBridge.nodeNeedsWrite(node, yMap.get(id))) continue;
        yMap.set(id, { ...node, selected: undefined, dragging: undefined });
      }
      return;
    }

    const nextIds = new Set(localNodes.map((n) => n.id));
    for (const id of Array.from(yMap.keys())) {
      if (!nextIds.has(id)) yMap.delete(id);
    }
    for (const node of localNodes) {
      const existing = yMap.get(node.id);
      if (!ReactFlowBridge.nodeNeedsWrite(node, existing)) continue;
      yMap.set(node.id, { ...node, selected: undefined, dragging: undefined });
    }
  }

  private writeEdgesToDoc(localEdges: FlowEdge[], dirty: Set<string> | null): void {
    const yMap = this.doc.edges;

    if (dirty) {
      const byId = new Map(localEdges.map((e) => [e.id, e]));
      for (const id of dirty) {
        const edge = byId.get(id);
        if (!edge) {
          yMap.delete(id);
          continue;
        }
        if (!ReactFlowBridge.edgeNeedsWrite(edge, yMap.get(id))) continue;
        yMap.set(id, { ...edge, selected: undefined });
      }
      return;
    }

    const nextIds = new Set(localEdges.map((e) => e.id));
    for (const id of Array.from(yMap.keys())) {
      if (!nextIds.has(id)) yMap.delete(id);
    }
    for (const edge of localEdges) {
      // Existing edges are updated, not skipped: a reconnect changes an edge's
      // endpoints in place, and skipping meant that never reached the document.
      if (!ReactFlowBridge.edgeNeedsWrite(edge, yMap.get(edge.id))) continue;
      yMap.set(edge.id, { ...edge, selected: undefined });
    }
  }
}
