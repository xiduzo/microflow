import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { isValueEqual, type FlowDocument, type FlowEdge, type FlowNode } from "@microflow/collab";
import { removeNodesWithEdges } from "./flow-edits";

/** Element-wise reference equality. Meaningful only because the merges below
 *  preserve identity for unchanged entries. */
function sameMembers<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

type XY = { x: number; y: number };

/**
 * One node's local edit that has not reached the Y.Doc yet.
 *
 * Scoped to what the user actually did, so rebasing it over the doc keeps
 * everything else the doc says. A drag is a `patch` with only `position`; it
 * must not carry the node's `data`, or a peer's rename landing in the same
 * frame would be overwritten by the stale copy. A ReactFlow `replace` hands
 * over a whole node, so it is diffed against the doc when recorded and only
 * the differing fields become intent — a selection-only replace (select-all)
 * records nothing at all.
 *
 * - `remove` — deleted locally.
 * - `add` — a node the doc does not have yet; the whole node is the user's.
 * - `patch` — fields of an existing node; only the keys present are the
 *   user's, and `data` holds only the changed data keys. Dropped if a peer
 *   deletes the node first (the delete wins).
 */
export type NodeIntent =
  | { kind: "remove" }
  | { kind: "add"; node: FlowNode }
  | {
      kind: "patch";
      position?: XY;
      width?: number;
      height?: number;
      type?: string;
      data?: Record<string, unknown>;
    };

type NodePatch = Extract<NodeIntent, { kind: "patch" }>;

/** Edge equivalent. An edge is atomic (ADR-0019), so there is no partial form. */
export type EdgeIntent = { kind: "remove" } | { kind: "put"; edge: FlowEdge; isNew: boolean };

/**
 * Bidirectional bridge between a `FlowDocument` (Y.Doc CRDT) and the
 * ReactFlow change protocol. Owns six named invariants:
 *
 * 1. **Classification** — `classifyNodeChange` / `classifyEdgeChange` decide
 *    whether a ReactFlow change is structural (flows to Y.Doc) or ephemeral
 *    (local React state only).
 * 2. **Loop guard** — `isFlushingToDoc` blocks the Yjs→React merge during
 *    our own synchronous `transact("local")`, so our outgoing writes don't
 *    immediately echo back into our snapshot.
 * 3. **Local-UI-state preservation** — `mergeYjsIntoSnapshot` carries
 *    `selected` / `dragging` (and a mid-drag position) from the current
 *    snapshot onto incoming Yjs nodes; those never round-trip through Y.Doc.
 * 4. **Diff** — `nodeNeedsWrite` / `edgeNeedsWrite` skip Y.Doc writes when
 *    nothing the doc owns changed, avoiding redundant CRDT updates.
 * 5. **RAF batching** — multiple structural changes in one frame coalesce
 *    into one `transact("local")` and therefore one UndoManager entry.
 * 6. **Pending intent is rebased, never dropped** — structural changes are
 *    recorded as `NodeIntent` / `EdgeIntent` until the flush. Every snapshot
 *    the bridge publishes is *doc state with pending intent on top*, whether
 *    the trigger was a local change or a doc change landing inside the frame;
 *    the flush then writes exactly the intent. One reconcile path for both
 *    directions — a peer's edit can no longer snap a drop back or resurrect a
 *    delete. Conflicts resolve as Yjs would: the local intent wins per field
 *    it touches, and a peer's delete wins over a local edit to that node.
 *
 * Constructed once per `FlowDocument`. The hook `useReactFlowBridge`
 * owns construction + teardown; route layouts may also construct one
 * directly in tests.
 *
 * Convergence (across clients) is the Y.Doc's responsibility, not the
 * bridge's — the bridge only must not break it. Specifically: writes are
 * tagged with origin `"local"` so the `UndoManager` tracks them
 * symmetrically; remote-origin updates flow through `mergeYjsIntoSnapshot`.
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

  /**
   * The fields of `local` that differ from the stored node, folded over any
   * `prior` patch for it — or `null` when nothing the doc owns differs.
   * `data` is diffed per key by value, so the patch carries only the keys the
   * user changed and a peer's edit to another key survives the flush.
   */
  static diffNode(local: FlowNode, stored: FlowNode, prior?: NodeIntent): NodePatch | null {
    const patch: NodePatch = prior?.kind === "patch" ? { ...prior } : { kind: "patch" };
    let changed = prior?.kind === "patch";
    if (local.position.x !== stored.position.x || local.position.y !== stored.position.y) {
      patch.position = local.position;
      changed = true;
    }
    for (const key of ["width", "height", "type"] as const) {
      if (local[key] === stored[key]) continue;
      (patch as Record<string, unknown>)[key] = local[key];
      changed = true;
    }
    if (local.data !== stored.data) {
      for (const [key, value] of Object.entries(local.data ?? {})) {
        if (isValueEqual(value, stored.data?.[key])) continue;
        patch.data = { ...patch.data, [key]: value };
        changed = true;
      }
    }
    return changed ? patch : null;
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

  // -------------------------------------------------------------------------
  // Instance state
  // -------------------------------------------------------------------------

  readonly doc: FlowDocument;

  private currentSnapshot: { nodes: FlowNode[]; edges: FlowEdge[] };
  private readonly listeners = new Set<() => void>();
  private readonly unobserveNodes: () => void;
  private readonly unobserveEdges: () => void;
  private readonly stopEdgePruning: () => void;

  private pendingFrame: number | null = null;

  /**
   * Local structural intent since the last flush, keyed by id. This is both
   * the write set (the flush walks only these ids, so dropping one node in a
   * 300-node flow costs one lookup) and what every snapshot rebuild lays over
   * the doc. Empty between frames.
   */
  private readonly nodeIntents = new Map<string, NodeIntent>();
  private readonly edgeIntents = new Map<string, EdgeIntent>();

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
    // While an Editor's canvas is open, the doc repairs edges left dangling by
    // concurrent peers (a delete racing a new edge). Through a Viewer's
    // read-only document this is a no-op that returns nothing.
    this.stopEdgePruning = (this.readOnly ? undefined : doc.startEdgePruning()) ?? (() => {});
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
    if (this.recordNodeIntents(changes, next)) this.scheduleFlush();
  }

  applyEdgeChanges(changes: EdgeChange[]): void {
    if (this.destroyed) return;
    const next = applyEdgeChanges(changes, this.currentSnapshot.edges) as FlowEdge[];
    this.setSnapshot({ ...this.currentSnapshot, edges: next });
    if (this.readOnly) return;
    if (this.recordEdgeIntents(changes, next)) this.scheduleFlush();
  }

  /**
   * Fold a batch of ReactFlow changes into `nodeIntents`. `next` is the
   * snapshot after the batch, read for the values the changes produced.
   * Returns whether any intent was recorded.
   */
  private recordNodeIntents(changes: NodeChange[], next: FlowNode[]): boolean {
    let byId: Map<string, FlowNode> | null = null;
    const after = (id: string) => (byId ??= new Map(next.map((n) => [n.id, n]))).get(id);
    let recorded = false;

    for (const change of changes) {
      if (ReactFlowBridge.classifyNodeChange(change) !== "structural") continue;
      switch (change.type) {
        case "remove":
          this.nodeIntents.set(change.id, { kind: "remove" });
          recorded = true;
          break;
        case "add":
        case "replace": {
          const id = change.item.id;
          const node = after(id) ?? (change.item as FlowNode);
          const prior = this.nodeIntents.get(id);
          const stored = this.doc.getNode(id);
          if (prior?.kind === "add" || !stored) {
            this.nodeIntents.set(id, { kind: "add", node });
            recorded = true;
            break;
          }
          // A re-add after a remove in the same frame supersedes the remove:
          // diff it against the doc afresh, and if nothing differs there is
          // nothing left to do — the node simply stays.
          const base = prior?.kind === "remove" ? undefined : prior;
          if (prior?.kind === "remove") this.nodeIntents.delete(id);
          const patch = ReactFlowBridge.diffNode(node, stored, base);
          if (patch) this.nodeIntents.set(id, patch);
          recorded = true;
          break;
        }
        case "position":
        case "dimensions": {
          // A measurement without `setAttributes` only fills ReactFlow's
          // `measured`; the doc's width/height are not involved.
          if (change.type === "dimensions" && !change.setAttributes) break;
          const node = after(change.id);
          if (!node) break;
          const prior = this.nodeIntents.get(change.id);
          if (prior?.kind === "remove") break;
          if (prior?.kind === "add") {
            this.nodeIntents.set(change.id, { kind: "add", node });
          } else {
            const patch: NodePatch = { kind: "patch", ...prior };
            if (change.type === "position") patch.position = node.position;
            else {
              if (change.setAttributes !== "height") patch.width = node.width;
              if (change.setAttributes !== "width") patch.height = node.height;
            }
            this.nodeIntents.set(change.id, patch);
          }
          recorded = true;
          break;
        }
      }
    }
    return recorded;
  }

  private recordEdgeIntents(changes: EdgeChange[], next: FlowEdge[]): boolean {
    let byId: Map<string, FlowEdge> | null = null;
    const after = (id: string) => (byId ??= new Map(next.map((e) => [e.id, e]))).get(id);
    let recorded = false;

    for (const change of changes) {
      if (ReactFlowBridge.classifyEdgeChange(change) !== "structural") continue;
      if (change.type === "remove") {
        this.edgeIntents.set(change.id, { kind: "remove" });
        recorded = true;
      } else if (change.type === "add" || change.type === "replace") {
        const id = change.item.id;
        const edge = after(id) ?? (change.item as FlowEdge);
        const prior = this.edgeIntents.get(id);
        const stored = this.doc.getEdge(id);
        // A selection-only replace carries nothing the doc owns.
        if (prior === undefined && stored && !ReactFlowBridge.edgeNeedsWrite(edge, stored)) continue;
        const isNew = prior?.kind === "put" ? prior.isNew : !stored;
        this.edgeIntents.set(id, { kind: "put", edge, isNew });
        recorded = true;
      }
    }
    return recorded;
  }

  /** Synchronously write pending intent to the doc. Public for tests and
   * callers that need a write barrier (e.g. before navigation). */
  flush(): void {
    if (this.pendingFrame !== null) {
      cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = null;
    }
    if (this.nodeIntents.size === 0 && this.edgeIntents.size === 0) return;

    let cascaded: string[] = [];
    this.isFlushingToDoc = true;
    try {
      this.doc.doc.transact(() => {
        cascaded = this.writeNodeIntents();
        this.writeEdgeIntents();
      }, "local");
    } finally {
      this.isFlushingToDoc = false;
      this.nodeIntents.clear();
      this.edgeIntents.clear();
    }

    // The node delete also removed edges the local snapshot may still show
    // (one a peer attached inside the frame), and an edge prune can run inside
    // the same transact call. Our own observer was muted for both, so pick
    // them up here rather than render a dangling edge.
    if (cascaded.length > 0 || this.doc.edges.size !== this.currentSnapshot.edges.length) {
      this.handleYjsEdgesChange();
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
    this.stopEdgePruning();
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
    const { droppedEdge } = this.dropIntentsDeletedByDoc();
    const merged = ReactFlowBridge.mergeYjsIntoSnapshot(
      this.doc.getNodes(),
      this.currentSnapshot.nodes,
      this.nodeIntents,
    );
    // With identity preserved, an update that changes nothing we render
    // produces an element-wise identical array. Publishing it anyway would
    // hand React a new snapshot object and re-render for nothing.
    if (!sameMembers(merged, this.currentSnapshot.nodes)) {
      this.setSnapshot({ ...this.currentSnapshot, nodes: merged });
    }
    // A node delete can void a pending new edge without touching the edge
    // map, so the edge observer would never hear of it.
    if (droppedEdge) this.handleYjsEdgesChange();
  };

  private handleYjsEdgesChange = (): void => {
    if (this.isFlushingToDoc || this.destroyed) return;
    this.dropIntentsDeletedByDoc();
    const merged = ReactFlowBridge.mergeEdgesYjsIntoSnapshot(
      this.doc.getEdges(),
      this.currentSnapshot.edges,
      this.edgeIntents,
    );
    if (sameMembers(merged, this.currentSnapshot.edges)) return;
    this.setSnapshot({ ...this.currentSnapshot, edges: merged });
  };

  /**
   * A peer's delete wins over a local edit to the same element: drop the
   * intent for anything that existed when the intent was taken and is gone
   * from the doc now. New elements (`add`, `isNew`) are ours to create and
   * stay — except an edge whose endpoint node was deleted, which would only
   * be written dangling. Walks only the pending intents, which are empty
   * between frames.
   */
  private dropIntentsDeletedByDoc(): { droppedEdge: boolean } {
    for (const [id, intent] of this.nodeIntents) {
      if (intent.kind !== "patch") continue;
      if (!this.doc.hasNode(id)) this.nodeIntents.delete(id);
    }
    let droppedEdge = false;
    for (const [id, intent] of this.edgeIntents) {
      if (intent.kind === "remove") continue;
      if (this.doc.isEdgeDangling(intent.edge) || (!intent.isNew && !this.doc.hasEdge(id))) {
        this.edgeIntents.delete(id);
        droppedEdge = true;
      }
    }
    return { droppedEdge };
  }

  /**
   * Rebase: the incoming Y.Doc nodes, with pending local intent laid on top
   * and local-only fields (`selected`, `dragging`) carried over.
   *
   * **Object identity is the point.** ReactFlow memoizes each node's render on
   * the identity of its node object, so returning a fresh object for every
   * node — which the obvious `yjsNodes.map(n => ({...n}))` does — re-renders
   * the entire canvas every time any peer touches any single node. In a room
   * with several active contributors that is the dominant cost in the editor.
   *
   * So an unchanged node returns *the existing reference*. Only nodes that
   * actually differ get a new object. The intent lookup costs one map probe
   * per node and only while intent is pending — in practice, one frame.
   *
   * A node mid-drag keeps its local position: the drag is local intent too,
   * just not yet a structural one, and a peer's unrelated edit must not snap
   * it back under the cursor.
   */
  static mergeYjsIntoSnapshot(
    yjsNodes: FlowNode[],
    currentLocal: FlowNode[],
    intents?: ReadonlyMap<string, NodeIntent>,
  ): FlowNode[] {
    const localMap = new Map(currentLocal.map((n) => [n.id, n]));
    const pending = intents && intents.size > 0 ? intents : null;
    const out: FlowNode[] = [];

    for (const yjsNode of yjsNodes) {
      const local = localMap.get(yjsNode.id);
      let base = yjsNode;
      if (pending) {
        const intent = pending.get(yjsNode.id);
        if (intent?.kind === "remove") continue;
        if (intent?.kind === "add") base = intent.node;
        else if (intent?.kind === "patch") base = ReactFlowBridge.withPatch(yjsNode, intent, local);
      }
      out.push(ReactFlowBridge.carryLocal(base, local));
    }

    // Local adds the doc has not seen yet.
    if (pending) {
      for (const [id, intent] of pending) {
        if (intent.kind !== "add") continue;
        if (yjsNodes.some((n) => n.id === id)) continue;
        out.push(ReactFlowBridge.carryLocal(intent.node, localMap.get(id)));
      }
    }
    return out;
  }

  /** Edge equivalent — only `selected` is local-only. Same identity rule. */
  static mergeEdgesYjsIntoSnapshot(
    yjsEdges: FlowEdge[],
    currentLocal: FlowEdge[],
    intents?: ReadonlyMap<string, EdgeIntent>,
  ): FlowEdge[] {
    const localMap = new Map(currentLocal.map((e) => [e.id, e]));
    const pending = intents && intents.size > 0 ? intents : null;
    const out: FlowEdge[] = [];
    const carry = (edge: FlowEdge, local: FlowEdge | undefined) => {
      const merged = { ...edge, selected: local?.selected };
      return local && ReactFlowBridge.edgesEquivalent(local, merged) ? local : merged;
    };

    for (const yjsEdge of yjsEdges) {
      const intent = pending?.get(yjsEdge.id);
      if (intent?.kind === "remove") continue;
      out.push(carry(intent?.kind === "put" ? intent.edge : yjsEdge, localMap.get(yjsEdge.id)));
    }
    if (pending) {
      for (const [id, intent] of pending) {
        if (intent.kind !== "put" || !intent.isNew) continue;
        if (yjsEdges.some((e) => e.id === id)) continue;
        out.push(carry(intent.edge, localMap.get(id)));
      }
    }
    return out;
  }

  /** `node` with a pending patch on top. Reuses `local.data` when the patched
   *  data holds the same values, so a pending data edit does not re-render
   *  its node on every unrelated doc change. */
  private static withPatch(node: FlowNode, patch: NodePatch, local: FlowNode | undefined): FlowNode {
    let data = node.data;
    if (patch.data) {
      data = { ...node.data, ...patch.data };
      if (local && ReactFlowBridge.shallowSame(local.data, data)) data = local.data;
    }
    return {
      ...node,
      position: patch.position ?? node.position,
      width: "width" in patch ? patch.width : node.width,
      height: "height" in patch ? patch.height : node.height,
      type: patch.type ?? node.type,
      data,
    };
  }

  private static shallowSame(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => key in b && Object.is(a[key], b[key]));
  }

  /** Lay the local-only fields onto `base`, returning `local` itself when the
   *  result renders the same — the identity rule above. */
  private static carryLocal(base: FlowNode, local: FlowNode | undefined): FlowNode {
    const merged = {
      ...base,
      position: local?.dragging ? local.position : base.position,
      selected: local?.selected,
      dragging: local?.dragging,
    };
    return local && ReactFlowBridge.nodesEquivalent(local, merged) ? local : merged;
  }

  /** Field-wise comparison over everything the canvas renders from a node. `data`
   *  is compared by reference — the doc hands out a fresh `data` object only when
   *  that node's data actually changed, which is exactly when we want a
   *  re-render. */
  private static nodesEquivalent(a: FlowNode, b: FlowNode): boolean {
    return (
      a.id === b.id &&
      a.type === b.type &&
      a.data === b.data &&
      a.position.x === b.position.x &&
      a.position.y === b.position.y &&
      a.width === b.width &&
      a.height === b.height &&
      a.selected === b.selected &&
      a.dragging === b.dragging
    );
  }

  private static edgesEquivalent(a: FlowEdge, b: FlowEdge): boolean {
    return (
      a.id === b.id &&
      a.type === b.type &&
      a.source === b.source &&
      a.target === b.target &&
      a.sourceHandle === b.sourceHandle &&
      a.targetHandle === b.targetHandle &&
      a.selected === b.selected
    );
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
   * Write node intent to the Y.Doc. Returns the ids of edges removed along
   * with deleted nodes.
   *
   * Writes go through `FlowDocument`, never at `doc.nodes` directly: the
   * document owns its storage shape (a node is a `Y.Map` with a nested `data`
   * map — ADR-0019), and a raw `set` here would write the legacy flat shape
   * and quietly opt the node out of per-field merging. A patch goes through
   * the field-scoped mutators so it touches only the keys the user changed.
   */
  private writeNodeIntents(): string[] {
    const removed: string[] = [];
    for (const [id, intent] of this.nodeIntents) {
      if (intent.kind === "remove") {
        removed.push(id);
        continue;
      }
      const stored = this.doc.getNode(id);
      if (intent.kind === "add") {
        if (!ReactFlowBridge.nodeNeedsWrite(intent.node, stored)) continue;
        this.doc.setNode({ ...intent.node, selected: undefined, dragging: undefined });
        continue;
      }
      // An existing node a peer deleted inside the frame stays deleted.
      if (!stored) continue;
      const { position } = intent;
      if (position && (position.x !== stored.position.x || position.y !== stored.position.y)) {
        this.doc.updateNodePosition(id, position);
      }
      const scalars: Partial<FlowNode> = {};
      if ("width" in intent && intent.width !== stored.width) scalars.width = intent.width;
      if ("height" in intent && intent.height !== stored.height) scalars.height = intent.height;
      if (intent.type !== undefined && intent.type !== stored.type) scalars.type = intent.type;
      if (Object.keys(scalars).length > 0) this.doc.updateNode(id, scalars);
      if (intent.data) this.doc.updateNodeData(id, intent.data);
    }
    // One delete for the batch, edges included: ReactFlow reports the edges it
    // can see, but a peer may have attached one inside the frame, and a node
    // delete must never leave an edge pointing at nothing.
    return removeNodesWithEdges(this.doc, removed);
  }

  private writeEdgeIntents(): void {
    for (const [id, intent] of this.edgeIntents) {
      if (intent.kind === "remove") {
        this.doc.removeEdge(id);
        continue;
      }
      const stored = this.doc.getEdge(id);
      if (!stored && !intent.isNew) continue;
      // Never write an edge to a deleted node — including one this very flush
      // just deleted (node intents are written first).
      if (this.doc.isEdgeDangling(intent.edge)) continue;
      // Existing edges are updated, not skipped: a reconnect changes an edge's
      // endpoints in place, and skipping meant that never reached the document.
      if (!ReactFlowBridge.edgeNeedsWrite(intent.edge, stored)) continue;
      this.doc.setEdge({ ...intent.edge, selected: undefined });
    }
  }
}
