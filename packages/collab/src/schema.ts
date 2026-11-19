import * as Y from "yjs";

// ============================================================================
// Types
// ============================================================================

export type FlowMeta = {
  name: string;
  description?: string;
  version: number;
  updatedAt: number;
  /**
   * The board target this Flow generates a Sketch for, stored as the stable
   * board-target identifier (e.g. `uno`, `nano`, `esp32`) defined by the
   * board-target abstraction. Undefined when the Author has never made a
   * selection, in which case consumers apply a default target.
   */
  selectedTargetId?: string;
};

export type FlowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  width?: number;
  height?: number;
  selected?: boolean;
  dragging?: boolean;
};

export type FlowEdge = {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
  type?: string;
  selected?: boolean;
};

export type FlowData = {
  nodes: FlowNode[];
  edges: FlowEdge[];
};

/** Fields the node's `Y.Map` carries alongside the nested `data` map. */
const NODE_SCALAR_KEYS = ["id", "type", "position", "width", "height"] as const;

/** Local-only; never written to the document. */
const LOCAL_ONLY_KEYS = new Set(["selected", "dragging"]);

/** Origin of the dangling-edge repair. Not `"local"`: the UndoManager must not
 *  track it, or an undo would put the dangling edge back. */
export const PRUNE_ORIGIN = "prune";

// ============================================================================
// Edge shape — the one reading of a value that should be an edge
// ============================================================================

/**
 * The one type the app gives an edge: the canvas and Ask AI both write it. The
 * canvas draws an edge without a type the same way.
 */
export const EDGE_TYPE = "animated";

/** Why a value cannot be read as an edge at all. */
export type EdgeDefect = "not-an-edge" | "no-id" | "no-source" | "no-target";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isName = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * A value nobody has checked, read as an edge in the shape the app writes one
 * in: its id, its two nodes, the handle it names at each end where it names
 * one (a non-empty string; anything else is no handle), and its type where
 * that is the app's. Whatever else the value holds is not in it. A value
 * without a usable id, source or target is no edge: what is wrong is returned
 * instead.
 *
 * The Flow File codec reads an imported edge with it, and `FlowDocument` a
 * stored one, so a file and a document cannot disagree about what an edge is.
 */
export function decodeEdge(raw: unknown): FlowEdge | EdgeDefect {
  if (!isRecord(raw)) return "not-an-edge";
  const { id, source, target, sourceHandle, targetHandle, type } = raw;
  if (!isName(id)) return "no-id";
  if (!isName(source)) return "no-source";
  if (!isName(target)) return "no-target";
  return {
    id,
    source,
    ...(isName(sourceHandle) ? { sourceHandle } : {}),
    target,
    ...(isName(targetHandle) ? { targetHandle } : {}),
    ...(type === EDGE_TYPE ? { type } : {}),
  };
}

/**
 * A stored value as the edge the app is given, or `null` when it is not one
 * the app can use: it cannot be read as an edge, or it names no handle at one
 * of its ends (the canvas cannot draw it and sketch generation refuses it).
 * Such a value stays in the document; it is not shown and not run.
 */
function wiredEdge(raw: unknown): FlowEdge | null {
  const edge = decodeEdge(raw);
  if (typeof edge === "string" || !edge.sourceHandle || !edge.targetHandle) return null;
  return edge;
}

/**
 * Build the `Y.Map` for a node, with `data` nested.
 *
 * The one place the storage shape is defined. `upgradeLegacyNodes` and
 * `FlowDocument` both go through it so they cannot drift.
 */
function buildNodeMap(node: FlowNode): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("id", node.id);
  map.set("type", node.type);
  map.set("position", { ...node.position });
  if (node.width !== undefined) map.set("width", node.width);
  if (node.height !== undefined) map.set("height", node.height);

  const data = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(node.data ?? {})) {
    if (LOCAL_ONLY_KEYS.has(key)) continue;
    data.set(key, value);
  }
  map.set("data", data);
  return map;
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPosition(value: unknown): { x: number; y: number } {
  if (value && typeof value === "object") {
    const { x, y } = value as { x?: unknown; y?: unknown };
    const fx = finiteOrUndefined(x);
    const fy = finiteOrUndefined(y);
    if (fx !== undefined && fy !== undefined) return value as { x: number; y: number };
    return { x: fx ?? 0, y: fy ?? 0 };
  }
  return { x: 0, y: 0 };
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[collab] ${message}`);
}

/**
 * Bring a document written before
 * [ADR-0019](../../../docs/adr/0019-nested-node-fields-for-concurrent-edits.md)
 * onto the nested node shape, in place.
 *
 * Run once at the load boundary — the room store on the server, IndexedDB on
 * the client — so the document is already correct by the time anything reads
 * it. `FlowDocument` itself has no legacy branch: it assumes every node is a
 * `Y.Map`, and this is what makes that assumption safe.
 *
 * The origin is `"migration"`, deliberately not `"local"`, so the upgrade is
 * not tracked by anyone's `UndoManager` and cannot be undone into a broken
 * state.
 *
 * **This function is disposable.** Once no stored document predates ADR-0019,
 * delete it and its call sites.
 *
 * @returns how many nodes were upgraded; 0 means the document was already current.
 */
export function upgradeLegacyNodes(doc: Y.Doc): number {
  const nodes = doc.getMap<unknown>("nodes");
  const legacy: Array<[string, FlowNode]> = [];

  for (const [id, value] of nodes.entries()) {
    if (value instanceof Y.Map) continue;
    if (value && typeof value === "object") legacy.push([id, value as FlowNode]);
  }
  if (legacy.length === 0) return 0;

  doc.transact(() => {
    for (const [id, node] of legacy) {
      nodes.set(id, buildNodeMap({ ...node, id: node.id ?? id }));
    }
  }, "migration");

  return legacy.length;
}

// ============================================================================
// Flow structure — the one visual-free projection of a Flow
// ============================================================================

/** A Node reduced to what any structural consumer needs: which Node it is,
 *  what kind it is, and how it is configured. */
export type StructuralNode = {
  id: string;
  type: string | null;
  data: Record<string, unknown>;
};

/** An Edge reduced to its endpoints — the wiring, without id or styling. */
export type StructuralEdge = {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
};

/** The Flow, minus how it looks. See {@link projectFlowStructure}. */
export type FlowStructure = {
  nodes: StructuralNode[];
  edges: StructuralEdge[];
};

/** Loose inputs so collab `FlowNode`, ReactFlow `Node` and the runtime wire
 *  shape all project without adaptation at the call site. */
// The index signature is the point: callers hand in whole nodes and edges, and
// everything not named here (position, dimensions, selection, edge id) is what
// the projection exists to drop.
type StructuralNodeInput = {
  id: string;
  type?: string | null;
  data?: Record<string, unknown>;
  [ignored: string]: unknown;
};

type StructuralEdgeInput = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  [ignored: string]: unknown;
};

/**
 * Project a Flow onto its **structure**: node id/type/config data and edge
 * endpoints. Everything that only describes how the Flow is *drawn* is
 * stripped — node `position`, `width`/`height`, `selected`, `dragging`, and
 * edge `id`/`type`/`selected`. Nodes and edges are sorted so a doc reorder
 * without a semantic change projects identically.
 *
 * This is the single definition of "the parts of the Flow that matter" shared
 * by every consumer that must not react to the Author moving a Node around:
 * the runtime dispatcher, the Arduino sketch generator, and the schematic
 * circuit builder.
 */
export function projectFlowStructure(
  nodes: StructuralNodeInput[],
  edges: StructuralEdgeInput[] = [],
): FlowStructure {
  return {
    nodes: nodes
      .map((n) => ({ id: n.id, type: n.type ?? null, data: n.data ?? {} }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: edges
      .map((e) => ({
        source: e.source,
        sourceHandle: e.sourceHandle ?? "",
        target: e.target,
        targetHandle: e.targetHandle ?? "",
      }))
      .sort((a, b) => {
        const ka = `${a.source} ${a.sourceHandle} ${a.target} ${a.targetHandle}`;
        const kb = `${b.source} ${b.sourceHandle} ${b.target} ${b.targetHandle}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      }),
  };
}

/** Stable string identity of {@link projectFlowStructure} — two Flows with the
 *  same structure always yield the same key, whatever their layout. */
export function flowStructureKey(
  nodes: StructuralNodeInput[],
  edges: StructuralEdgeInput[] = [],
): string {
  return JSON.stringify(projectFlowStructure(nodes, edges));
}

/** Value equality for the JSON-ish values a Flow doc holds. Key order is
 *  irrelevant; `undefined` is a value, not an absent key.
 *
 *  Exported as the one definition of "unchanged" for document data: the node
 *  data committer's echo suppression must agree with the document's own
 *  no-op write guard, or one side writes what the other calls a no-op. */
export function isValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => isValueEqual(item, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  if (aKeys.length !== Object.keys(bo).length) return false;
  return aKeys.every((key) => key in bo && isValueEqual(ao[key], bo[key]));
}

// ============================================================================
// FlowDocument - Yjs-first document wrapper
// ============================================================================

/**
 * The Flow's CRDT document.
 *
 * **Storage shape.** A node is a `Y.Map` whose `data` is a further `Y.Map`, so
 * two people editing different fields of the same node *merge* instead of
 * clobbering. The previous shape stored each node as a plain JavaScript object,
 * which Yjs treats as an opaque atom: every write replaced the whole node and
 * the later write won outright, silently discarding the other. That read to
 * users as lost work, and it is the failure this shape exists to remove.
 * `position` stays a plain object deliberately — `x` and `y` are only ever
 * written together by a drag, so splitting them buys nothing.
 *
 * **Reference stability is load-bearing.** `getNodes()` materialises plain
 * `FlowNode` objects out of those maps, and `ReactFlowBridge` decides whether
 * to re-render a node by comparing `data` *by reference*. A fresh object per
 * read would silently re-render every node on the canvas whenever anybody
 * touched anything — the single largest client-side cost the collaboration
 * audit removed. So materialised nodes are cached and invalidated per id from
 * a deep observer: an untouched node yields the identical object across calls.
 * Do not remove that cache without understanding what it holds up.
 *
 * **Nodes are `Y.Map`s, upgraded by their owner.** A document written before
 * ADR-0019 is brought forward by `upgradeLegacyNodes` where it is loaded and
 * owned: the room store on the server, IndexedDB on the client. Two places can
 * still hand this class a plain-object node, and neither may write the upgrade
 * itself: a cloud seed (the server upgrades that room on load and syncs it
 * down; a client upgrade racing it would drop whichever side lost), and a live
 * update from an outdated client. So reads accept the old shape, and a write
 * to such a node replaces it with the map form carrying the edit. That branch
 * is confined to `materialiseNode` and the three writers, and goes when
 * `upgradeLegacyNodes` does.
 */
export class FlowDocument {
  readonly doc: Y.Doc;
  readonly meta: Y.Map<unknown>;
  readonly nodes: Y.Map<Y.Map<unknown>>;
  readonly edges: Y.Map<FlowEdge>;
  readonly undoManager: Y.UndoManager;

  /**
   * Materialised nodes, keyed by id. Invalidated per id by the deep observer
   * below, which is registered first so it runs before any consumer callback
   * and consumers therefore never read a stale entry.
   */
  private readonly nodeCache = new Map<string, FlowNode>();
  private readonly unobserveCache: () => void;

  /**
   * Stored edges as the app is given them (`wiredEdge`), keyed by the stored
   * value. A stored value is never changed in place (a write replaces it), so
   * its reading holds for good, and an untouched edge yields the identical
   * object across reads, as a node does.
   */
  private readonly edgeReadings = new WeakMap<object, FlowEdge | null>();

  constructor(doc?: Y.Doc) {
    this.doc = doc ?? new Y.Doc();
    this.meta = this.doc.getMap("meta");
    this.nodes = this.doc.getMap("nodes");
    this.edges = this.doc.getMap("edges");

    const invalidate = (events: Array<Y.YEvent<any>>) => {
      for (const event of events) {
        if (event.path.length === 0) {
          // A change on the top-level map: nodes added, replaced or removed.
          for (const id of event.changes.keys.keys()) this.nodeCache.delete(id);
        } else {
          // A change inside one node (its own map, or its nested `data`).
          this.nodeCache.delete(String(event.path[0]));
        }
      }
    };
    this.nodes.observeDeep(invalidate);
    this.unobserveCache = () => this.nodes.unobserveDeep(invalidate);

    // Built-in undo/redo that works across clients. The scope covers the
    // nested maps too, so a `data` field edit is undoable like any other.
    this.undoManager = new Y.UndoManager([this.nodes, this.edges], {
      trackedOrigins: new Set(["local"]),
      captureTimeout: 500, // Group rapid changes
    });
  }

  // --------------------------------------------------------------------------
  // Storage <-> plain object
  // --------------------------------------------------------------------------

  /** Read one node as a plain object, cached for reference stability. */
  private materialiseNode(id: string): FlowNode | undefined {
    const cached = this.nodeCache.get(id);
    if (cached) return cached;

    const stored: unknown = this.nodes.get(id);
    if (stored === undefined) return undefined;

    // A node is a `Y.Map` everywhere the doc was upgraded by its owner (the
    // room store, IndexedDB). A plain object can still be here, read-only: a
    // cloud seed is applied as the server persisted it — the server upgrades
    // the room on load and syncs that upgrade down, and a client writing its
    // own upgrade into the seed would race it — and a live update from a
    // client that predates ADR-0019 writes the old shape. Read either; reading
    // a plain object as a `Y.Map` would throw on every `getNodes()` and take
    // the canvas and the runtime dispatch down with it.
    let get: (key: string) => unknown;
    const data: Record<string, unknown> = {};
    if (stored instanceof Y.Map) {
      get = (key) => stored.get(key);
      const storedData = stored.get("data");
      if (storedData instanceof Y.Map) {
        for (const [key, value] of storedData.entries()) data[key] = value;
      }
    } else if (stored && typeof stored === "object") {
      const legacy = stored as Record<string, unknown>;
      get = (key) => legacy[key];
      if (legacy.data && typeof legacy.data === "object") {
        for (const [key, value] of Object.entries(legacy.data)) {
          if (!LOCAL_ONLY_KEYS.has(key)) data[key] = value;
        }
      }
    } else {
      warnOnce(`node ${id} is neither a Y.Map nor an object; skipping it`);
      return undefined;
    }

    // The document is shared and written by every client in the room, so its
    // scalars are checked rather than cast: a malformed value is replaced by
    // the same default a missing one gets.
    const storedId = get("id");
    const type = get("type");
    const node = {
      id: typeof storedId === "string" ? storedId : id,
      type: typeof type === "string" ? type : "",
      position: readPosition(get("position")),
      data,
      width: finiteOrUndefined(get("width")),
      height: finiteOrUndefined(get("height")),
    } satisfies FlowNode;

    this.nodeCache.set(id, node);
    return node;
  }

  /**
   * Write a whole node.
   *
   * Skips rewriting `data` when the caller hands back the same object we
   * materialised — the common case for a drag, where only `position` moved.
   * Rewriting it would churn the CRDT and defeat the per-field merge for
   * anyone editing that node concurrently.
   */
  private writeNode(node: FlowNode): void {
    const existing: unknown = this.nodes.get(node.id);

    // New, or still in the pre-ADR-0019 shape: write the whole node as a map.
    // For a legacy node this is the user's own edit upgrading it — the one
    // client-side write to such a node, and it carries the edit with it.
    if (!(existing instanceof Y.Map)) {
      this.nodes.set(node.id, buildNodeMap(node));
      return;
    }

    for (const key of NODE_SCALAR_KEYS) {
      const value = node[key];
      if (value === undefined) {
        if (existing.has(key)) existing.delete(key);
        continue;
      }
      const current = existing.get(key);
      if (key === "position") {
        const next = value as { x: number; y: number };
        const prev = current as { x: number; y: number } | undefined;
        if (prev && prev.x === next.x && prev.y === next.y) continue;
        existing.set(key, { ...next });
        continue;
      }
      if (!isValueEqual(current, value)) existing.set(key, value);
    }

    const cached = this.nodeCache.get(node.id);
    if (cached && cached.data === node.data) return;
    this.writeNodeData(existing, node.data ?? {}, true);
  }

  /**
   * Apply `data` onto the node's nested map. With `replace`, keys absent from
   * `data` are removed; otherwise this is a patch and untouched keys survive —
   * which is what lets two people edit different fields concurrently.
   */
  private writeNodeData(
    nodeMap: Y.Map<unknown>,
    data: Record<string, unknown>,
    replace: boolean,
  ): void {
    const existing = nodeMap.get("data");
    let target: Y.Map<unknown>;
    if (existing instanceof Y.Map) {
      target = existing as Y.Map<unknown>;
    } else {
      target = new Y.Map<unknown>();
      nodeMap.set("data", target);
    }

    if (replace) {
      for (const key of Array.from(target.keys())) {
        if (!(key in data)) target.delete(key);
      }
    }
    for (const [key, value] of Object.entries(data)) {
      if (LOCAL_ONLY_KEYS.has(key)) continue;
      // By value, not identity: a leva control hands back a fresh array or
      // object on every render, and an identity check would write — and fan
      // an update out to the whole room — for data that did not change.
      if (!isValueEqual(target.get(key), value)) target.set(key, value);
    }
  }

  // --------------------------------------------------------------------------
  // Node Operations
  // --------------------------------------------------------------------------

  addNode(node: FlowNode): void {
    this.doc.transact(() => {
      this.nodes.set(node.id, buildNodeMap(node));
    }, "local");
  }

  /** Write a whole node. Used by the ReactFlow bridge's flush. */
  setNode(node: FlowNode): void {
    this.doc.transact(() => {
      this.writeNode(node);
    }, "local");
  }

  updateNode(nodeId: string, updates: Partial<FlowNode>): void {
    this.doc.transact(() => {
      const existing = this.materialiseNode(nodeId);
      if (!existing) return;
      this.writeNode({ ...existing, ...updates });
    }, "local");
  }

  updateNodePosition(nodeId: string, position: { x: number; y: number }): void {
    this.doc.transact(() => {
      const stored: unknown = this.nodes.get(nodeId);
      if (stored === undefined) return;
      if (!(stored instanceof Y.Map)) {
        const legacy = this.materialiseNode(nodeId);
        if (legacy) this.writeNode({ ...legacy, position });
        return;
      }
      // Skip a move that moved nothing: a Y.Map `set` emits an update even for
      // an unchanged value, and that fans out to every observer in the room.
      const prev = stored.get("position") as { x: number; y: number } | undefined;
      if (prev && prev.x === position.x && prev.y === position.y) return;
      // Touches only the `position` key, so a peer editing this node's `data`
      // at the same moment keeps their edit.
      stored.set("position", { ...position });
    }, "local");
  }

  /**
   * Patch fields on a node's `data`.
   *
   * The whole point of the nested shape: this writes only the keys in `data`,
   * so a concurrent edit to a *different* key on the same node survives
   * instead of being overwritten by a whole-node replace.
   */
  updateNodeData(nodeId: string, data: Record<string, unknown>): void {
    this.doc.transact(() => {
      const stored: unknown = this.nodes.get(nodeId);
      if (stored === undefined) return;
      if (!(stored instanceof Y.Map)) {
        const legacy = this.materialiseNode(nodeId);
        if (legacy) this.writeNode({ ...legacy, data: { ...legacy.data, ...data } });
        return;
      }
      // `writeNodeData` already skips keys whose value is unchanged.
      this.writeNodeData(stored, data, false);
    }, "local");
  }

  /** Remove a node and every edge attached to it. */
  removeNode(nodeId: string): void {
    this.doc.transact(() => {
      this.nodes.delete(nodeId);
      // Also remove connected edges
      for (const [edgeId, edge] of Array.from(this.edges.entries())) {
        if (edge.source === nodeId || edge.target === nodeId) {
          this.edges.delete(edgeId);
        }
      }
    }, "local");
  }

  /** Remove a node only. The bridge uses this: ReactFlow reports the edge
   *  removals itself, so cascading here would be a second opinion. */
  deleteNode(nodeId: string): void {
    this.doc.transact(() => {
      this.nodes.delete(nodeId);
    }, "local");
  }

  hasNode(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  getNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  // --------------------------------------------------------------------------
  // Edge Operations
  // --------------------------------------------------------------------------
  //
  // Edges stay plain objects. An edge has no field two people would edit
  // independently — a reconnect replaces its endpoints as a unit — so nesting
  // would add indirection for a conflict that cannot arise.

  addEdge(edge: FlowEdge): void {
    this.doc.transact(() => {
      this.edges.set(edge.id, { ...edge });
    }, "local");
  }

  /** Write a whole edge. Same no-op write guard as the node mutators. */
  setEdge(edge: FlowEdge): void {
    const existing = this.edges.get(edge.id);
    if (existing && isValueEqual(existing, edge)) return;
    this.doc.transact(() => {
      this.edges.set(edge.id, { ...edge });
    }, "local");
  }

  /** Same no-op write guard: an unchanged `set` still fans out an update. */
  updateEdge(edgeId: string, updates: Partial<FlowEdge>): void {
    const existing = this.edges.get(edgeId);
    if (!existing) return;
    const next = { ...existing, ...updates };
    if (isValueEqual(existing, next)) return;
    this.doc.transact(() => {
      this.edges.set(edgeId, next);
    }, "local");
  }

  removeEdge(edgeId: string): void {
    this.doc.transact(() => {
      this.edges.delete(edgeId);
    }, "local");
  }

  hasEdge(edgeId: string): boolean {
    return this.edges.has(edgeId);
  }

  getEdgeIds(): string[] {
    return Array.from(this.edges.keys());
  }

  // --------------------------------------------------------------------------
  // Dangling edges
  // --------------------------------------------------------------------------
  //
  // Every local delete removes a node's edges with it, but two peers can still
  // race: A deletes a node while B wires a new edge to it. Both writes are
  // valid where they were made, and the merge holds an edge pointing at
  // nothing. The document repairs that itself, after the fact, because no
  // single client can prevent it beforehand.

  /**
   * Whether this document held `nodeId` and has since seen it deleted — a Yjs
   * tombstone — as opposed to a node it never held. Only the first kind makes
   * an edge dangling: an edge to an id the document has not seen yet may
   * simply be ahead of the update that carries its node.
   */
  nodeWasDeleted(nodeId: string): boolean {
    if (this.nodes.has(nodeId)) return false;
    return this.nodes._map.get(nodeId)?.deleted === true;
  }

  /** Whether either endpoint of `edge` is a deleted node. */
  isEdgeDangling(edge: Pick<FlowEdge, "source" | "target">): boolean {
    return this.nodeWasDeleted(edge.source) || this.nodeWasDeleted(edge.target);
  }

  /**
   * Delete every edge whose source or target node was deleted. Returns their
   * ids. Written with origin `"prune"`, outside the UndoManager's tracked set:
   * the repair is not a user edit, and undoing it would only bring the
   * dangling edge back. Deletes are idempotent in Yjs, so peers pruning the
   * same edge concurrently converge.
   */
  pruneDanglingEdges(): string[] {
    const dangling: string[] = [];
    for (const [id, edge] of this.edges.entries()) {
      if (this.isEdgeDangling(edge)) dangling.push(id);
    }
    if (dangling.length === 0) return dangling;
    this.doc.transact(() => {
      for (const id of dangling) this.edges.delete(id);
    }, PRUNE_ORIGIN);
    return dangling;
  }

  /**
   * Keep this document free of dangling edges from now on: prune once (the
   * load case), then again after any transaction — local or remote — that
   * deleted a node or wrote an edge to a deleted one. Returns the stop
   * function.
   *
   * Opt-in, and a mutator on purpose: a Viewer's writes are refused by the
   * room, so a Viewer must never prune. The web app's editor session starts it
   * while the session is writable and stops it on destroy; through
   * `readOnlyDocument` this method is a no-op. Start it once per document:
   * each call registers its own listener.
   */
  startEdgePruning(): () => void {
    this.pruneDanglingEdges();
    const afterTransaction = (transaction: Y.Transaction) => {
      if (transaction.origin === PRUNE_ORIGIN) return;
      if (this.transactionLeftDanglingEdges(transaction)) this.pruneDanglingEdges();
    };
    this.doc.on("afterTransaction", afterTransaction);
    return () => this.doc.off("afterTransaction", afterTransaction);
  }

  /** Cheap trigger check: only the keys the transaction touched. */
  private transactionLeftDanglingEdges(transaction: Y.Transaction): boolean {
    // `changed` is keyed by the generic AbstractType; our maps are narrower.
    const changed = transaction.changed as Map<unknown, Set<string | null>>;
    for (const key of changed.get(this.nodes) ?? []) {
      if (key !== null && this.nodeWasDeleted(key)) return true;
    }
    for (const key of changed.get(this.edges) ?? []) {
      const edge = key === null ? undefined : this.edges.get(key);
      if (edge && this.isEdgeDangling(edge)) return true;
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Bulk Operations
  // --------------------------------------------------------------------------

  setFlowData(nodes: FlowNode[], edges: FlowEdge[]): void {
    this.doc.transact(() => {
      this.nodes.clear();
      this.edges.clear();
      nodes.forEach((n) => this.nodes.set(n.id, buildNodeMap(n)));
      edges.forEach((e) => this.edges.set(e.id, { ...e }));
    }, "local");
  }

  clear(): void {
    this.doc.transact(() => {
      this.nodes.clear();
      this.edges.clear();
    }, "local");
  }

  // --------------------------------------------------------------------------
  // Meta Operations
  // --------------------------------------------------------------------------

  setMeta(meta: Partial<FlowMeta>): void {
    this.doc.transact(() => {
      Object.entries(meta).forEach(([key, value]) => {
        this.meta.set(key, value);
      });
      this.meta.set("updatedAt", Date.now());
    }, "local");
  }

  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  getNodes(): FlowNode[] {
    const out: FlowNode[] = [];
    for (const id of this.nodes.keys()) {
      const node = this.materialiseNode(id);
      if (node) out.push(node);
    }
    return out;
  }

  getNode(nodeId: string): FlowNode | undefined {
    return this.materialiseNode(nodeId);
  }

  /**
   * The edges the app can use. The document is shared and written by every
   * client in the room, and an old import wrote what a file held, so a stored
   * edge is read, not cast: one without a usable id, source or target, or
   * that names no handle at one of its ends, is left out here (`wiredEdge`).
   * It stays in the document, untouched: the canvas, the runtime, the Code
   * view and a published flow's readers never see it, and nothing deletes it
   * for being there.
   */
  getEdges(): FlowEdge[] {
    const out: FlowEdge[] = [];
    for (const raw of this.edges.values()) {
      const edge = this.readEdge(raw);
      if (edge) out.push(edge);
    }
    return out;
  }

  /** One edge as {@link getEdges} reads it; `undefined` when it is absent or left out. */
  getEdge(edgeId: string): FlowEdge | undefined {
    return this.readEdge(this.edges.get(edgeId)) ?? undefined;
  }

  private readEdge(raw: unknown): FlowEdge | null {
    if (typeof raw !== "object" || raw === null) return null;
    const known = this.edgeReadings.get(raw);
    if (known !== undefined) return known;
    const edge = wiredEdge(raw);
    // Already in the app's shape: the stored value itself is the edge.
    const reading = edge && isValueEqual(edge, raw) ? (raw as FlowEdge) : edge;
    this.edgeReadings.set(raw, reading);
    return reading;
  }

  getMeta(): FlowMeta {
    return {
      name: (this.meta.get("name") as string) ?? "Untitled",
      description: this.meta.get("description") as string | undefined,
      version: (this.meta.get("version") as number) ?? 1,
      updatedAt: (this.meta.get("updatedAt") as number) ?? Date.now(),
      selectedTargetId: this.meta.get("selectedTargetId") as string | undefined,
    };
  }

  getFlowData(): FlowData {
    return {
      nodes: this.getNodes(),
      edges: this.getEdges(),
    };
  }

  // --------------------------------------------------------------------------
  // History (Undo/Redo)
  // --------------------------------------------------------------------------

  undo(): void {
    this.undoManager.undo();
  }

  redo(): void {
    this.undoManager.redo();
  }

  canUndo(): boolean {
    return this.undoManager.canUndo();
  }

  canRedo(): boolean {
    return this.undoManager.canRedo();
  }

  clearHistory(): void {
    this.undoManager.clear();
  }

  // --------------------------------------------------------------------------
  // Observers
  // --------------------------------------------------------------------------

  /**
   * Deep by necessity: a change to a node's `data` fires on that node's nested
   * map, not on the top-level `nodes` map. A shallow observer here would miss
   * every field edit.
   */
  onNodesChange(callback: () => void): () => void {
    const handler = () => callback();
    this.nodes.observeDeep(handler);
    return () => this.nodes.unobserveDeep(handler);
  }

  onEdgesChange(callback: () => void): () => void {
    this.edges.observe(callback);
    return () => this.edges.unobserve(callback);
  }

  onMetaChange(callback: () => void): () => void {
    this.meta.observe(callback);
    return () => this.meta.unobserve(callback);
  }

  onAnyChange(callback: (update: Uint8Array, origin: unknown) => void): () => void {
    this.doc.on("update", callback);
    return () => this.doc.off("update", callback);
  }

  // --------------------------------------------------------------------------
  // Serialization
  // --------------------------------------------------------------------------

  encode(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  static decode(data: Uint8Array): FlowDocument {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, data);
    return new FlowDocument(doc);
  }

  static createEmpty(): FlowDocument {
    return new FlowDocument();
  }

  destroy(): void {
    this.unobserveCache();
    this.nodeCache.clear();
    this.undoManager.destroy();
    this.doc.destroy();
  }
}
