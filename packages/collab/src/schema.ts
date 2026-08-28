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

/**
 * How a node is stored. New writes produce a `Y.Map`; documents written before
 * [ADR-0017](../../../docs/adr/0017-nested-node-fields-for-concurrent-edits.md)
 * hold a plain object, which reads still accept. See `materialiseNode`.
 */
type StoredNode = Y.Map<unknown> | FlowNode;

/** Fields the node's `Y.Map` carries alongside the nested `data` map. */
const NODE_SCALAR_KEYS = ["id", "type", "position", "width", "height"] as const;

/** Local-only; never written to the document. */
const LOCAL_ONLY_KEYS = new Set(["selected", "dragging"]);

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
 * **Reads accept both shapes.** Documents persisted before the change hold
 * plain objects. They are read as-is and upgraded on their first write, so a
 * mixed document is correct at every point and an old client can share a room
 * with a new one.
 */
export class FlowDocument {
  readonly doc: Y.Doc;
  readonly meta: Y.Map<unknown>;
  readonly nodes: Y.Map<StoredNode>;
  readonly edges: Y.Map<FlowEdge>;
  readonly undoManager: Y.UndoManager;

  /**
   * Materialised nodes, keyed by id. Invalidated per id by the deep observer
   * below, which is registered first so it runs before any consumer callback
   * and consumers therefore never read a stale entry.
   */
  private readonly nodeCache = new Map<string, FlowNode>();
  private readonly unobserveCache: () => void;

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

  /** Build the `Y.Map` for a node, with `data` nested. */
  private static buildNodeMap(node: FlowNode): Y.Map<unknown> {
    const map = new Y.Map<unknown>();
    map.set("id", node.id);
    map.set("type", node.type);
    map.set("position", { ...node.position });
    if (node.width !== undefined) map.set("width", node.width);
    if (node.height !== undefined) map.set("height", node.height);

    const data = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(node.data ?? {})) {
      data.set(key, value);
    }
    map.set("data", data);
    return map;
  }

  /**
   * Read one node as a plain object, from either storage shape.
   *
   * Legacy plain objects are returned as Yjs stored them — already a stable
   * reference — so they need no cache entry of their own.
   */
  private materialiseNode(id: string): FlowNode | undefined {
    const cached = this.nodeCache.get(id);
    if (cached) return cached;

    const stored = this.nodes.get(id);
    if (stored === undefined) return undefined;

    if (!(stored instanceof Y.Map)) {
      // Pre-ADR-0017 document: the value is the node.
      return stored as FlowNode;
    }

    const data: Record<string, unknown> = {};
    const storedData = stored.get("data");
    if (storedData instanceof Y.Map) {
      for (const [key, value] of storedData.entries()) data[key] = value;
    } else if (storedData && typeof storedData === "object") {
      Object.assign(data, storedData);
    }

    const node = {
      id: (stored.get("id") as string) ?? id,
      type: stored.get("type") as string,
      position: (stored.get("position") as { x: number; y: number }) ?? { x: 0, y: 0 },
      data,
      width: stored.get("width") as number | undefined,
      height: stored.get("height") as number | undefined,
    } satisfies FlowNode;

    this.nodeCache.set(id, node);
    return node;
  }

  /**
   * Write a whole node, upgrading a legacy entry to the nested shape.
   *
   * Skips rewriting `data` when the caller hands back the same object we
   * materialised — the common case for a drag, where only `position` moved.
   * Rewriting it would churn the CRDT and defeat the per-field merge for
   * anyone editing that node concurrently.
   */
  private writeNode(node: FlowNode): void {
    const existing = this.nodes.get(node.id);

    if (!(existing instanceof Y.Map)) {
      this.nodes.set(node.id, FlowDocument.buildNodeMap(node));
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
      if (current !== value) existing.set(key, value);
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
    let dataMap = nodeMap.get("data");
    if (!(dataMap instanceof Y.Map)) {
      const upgraded = new Y.Map<unknown>();
      // Carry over a legacy plain `data` object before replacing it.
      if (dataMap && typeof dataMap === "object") {
        for (const [key, value] of Object.entries(dataMap)) upgraded.set(key, value);
      }
      nodeMap.set("data", upgraded);
      dataMap = upgraded;
    }
    const target = dataMap as Y.Map<unknown>;

    if (replace) {
      for (const key of Array.from(target.keys())) {
        if (!(key in data)) target.delete(key);
      }
    }
    for (const [key, value] of Object.entries(data)) {
      if (LOCAL_ONLY_KEYS.has(key)) continue;
      if (target.get(key) !== value) target.set(key, value);
    }
  }

  // --------------------------------------------------------------------------
  // Node Operations
  // --------------------------------------------------------------------------

  addNode(node: FlowNode): void {
    this.doc.transact(() => {
      this.nodes.set(node.id, FlowDocument.buildNodeMap(node));
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
      const stored = this.nodes.get(nodeId);
      if (stored === undefined) return;
      if (stored instanceof Y.Map) {
        // Touches only the `position` key, so a peer editing this node's
        // `data` at the same moment keeps their edit.
        stored.set("position", { ...position });
        return;
      }
      this.nodes.set(
        nodeId,
        FlowDocument.buildNodeMap({ ...(stored as FlowNode), position }),
      );
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
      const stored = this.nodes.get(nodeId);
      if (stored === undefined) return;

      if (stored instanceof Y.Map) {
        this.writeNodeData(stored, data, false);
        return;
      }

      const legacy = stored as FlowNode;
      this.nodes.set(
        nodeId,
        FlowDocument.buildNodeMap({ ...legacy, data: { ...legacy.data, ...data } }),
      );
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

  setEdge(edge: FlowEdge): void {
    this.doc.transact(() => {
      this.edges.set(edge.id, { ...edge });
    }, "local");
  }

  updateEdge(edgeId: string, updates: Partial<FlowEdge>): void {
    this.doc.transact(() => {
      const existing = this.edges.get(edgeId);
      if (existing) {
        this.edges.set(edgeId, { ...existing, ...updates });
      }
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
  // Bulk Operations
  // --------------------------------------------------------------------------

  setFlowData(nodes: FlowNode[], edges: FlowEdge[]): void {
    this.doc.transact(() => {
      this.nodes.clear();
      this.edges.clear();
      nodes.forEach((n) => this.nodes.set(n.id, FlowDocument.buildNodeMap(n)));
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

  getEdges(): FlowEdge[] {
    return Array.from(this.edges.values());
  }

  getEdge(edgeId: string): FlowEdge | undefined {
    return this.edges.get(edgeId);
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
