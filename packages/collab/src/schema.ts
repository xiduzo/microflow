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
type StructuralNodeInput = {
  id: string;
  type?: string | null;
  data?: Record<string, unknown>;
};

type StructuralEdgeInput = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
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
 *  irrelevant; `undefined` is a value, not an absent key. */
function isValueEqual(a: unknown, b: unknown): boolean {
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

export class FlowDocument {
  readonly doc: Y.Doc;
  readonly meta: Y.Map<unknown>;
  readonly nodes: Y.Map<FlowNode>;
  readonly edges: Y.Map<FlowEdge>;
  readonly undoManager: Y.UndoManager;

  constructor(doc?: Y.Doc) {
    this.doc = doc ?? new Y.Doc();
    this.meta = this.doc.getMap("meta");
    this.nodes = this.doc.getMap("nodes");
    this.edges = this.doc.getMap("edges");

    // Built-in undo/redo that works across clients
    this.undoManager = new Y.UndoManager([this.nodes, this.edges], {
      trackedOrigins: new Set(["local"]),
      captureTimeout: 500, // Group rapid changes
    });
  }

  // --------------------------------------------------------------------------
  // Node Operations
  // --------------------------------------------------------------------------

  addNode(node: FlowNode): void {
    this.doc.transact(() => {
      this.nodes.set(node.id, { ...node });
    }, "local");
  }

  /**
   * Write `next` for `nodeId` only when it differs in value from what is
   * stored. A Y.Map `set` always emits an update even when the value is
   * unchanged, and that update fans out to every observer, the ReactFlow
   * bridge, the runtime dispatcher, the undo stack and persistence — so a
   * no-op write is never free. Every node mutator routes through here.
   */
  private setNodeIfChanged(nodeId: string, existing: FlowNode, next: FlowNode): void {
    if (isValueEqual(existing, next)) return;
    this.doc.transact(() => {
      this.nodes.set(nodeId, next);
    }, "local");
  }

  updateNode(nodeId: string, updates: Partial<FlowNode>): void {
    const existing = this.nodes.get(nodeId);
    if (!existing) return;
    this.setNodeIfChanged(nodeId, existing, { ...existing, ...updates });
  }

  updateNodePosition(nodeId: string, position: { x: number; y: number }): void {
    const existing = this.nodes.get(nodeId);
    if (!existing) return;
    this.setNodeIfChanged(nodeId, existing, { ...existing, position });
  }

  updateNodeData(nodeId: string, data: Record<string, unknown>): void {
    const existing = this.nodes.get(nodeId);
    if (!existing) return;
    this.setNodeIfChanged(nodeId, existing, {
      ...existing,
      data: { ...existing.data, ...data },
    });
  }

  removeNode(nodeId: string): void {
    this.doc.transact(() => {
      this.nodes.delete(nodeId);
      // Also remove connected edges
      this.edges.forEach((edge, edgeId) => {
        if (edge.source === nodeId || edge.target === nodeId) {
          this.edges.delete(edgeId);
        }
      });
    }, "local");
  }

  // --------------------------------------------------------------------------
  // Edge Operations
  // --------------------------------------------------------------------------

  addEdge(edge: FlowEdge): void {
    this.doc.transact(() => {
      this.edges.set(edge.id, { ...edge });
    }, "local");
  }

  /** Edge counterpart of {@link setNodeIfChanged} — same no-op write guard. */
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

  // --------------------------------------------------------------------------
  // Bulk Operations
  // --------------------------------------------------------------------------

  setFlowData(nodes: FlowNode[], edges: FlowEdge[]): void {
    this.doc.transact(() => {
      this.nodes.clear();
      this.edges.clear();
      nodes.forEach((n) => this.nodes.set(n.id, n));
      edges.forEach((e) => this.edges.set(e.id, e));
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
    return Array.from(this.nodes.values());
  }

  getNode(nodeId: string): FlowNode | undefined {
    return this.nodes.get(nodeId);
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

  onNodesChange(callback: () => void): () => void {
    this.nodes.observe(callback);
    return () => this.nodes.unobserve(callback);
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
    this.undoManager.destroy();
    this.doc.destroy();
  }
}
