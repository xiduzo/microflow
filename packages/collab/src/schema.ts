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

  updateNode(nodeId: string, updates: Partial<FlowNode>): void {
    this.doc.transact(() => {
      const existing = this.nodes.get(nodeId);
      if (existing) {
        this.nodes.set(nodeId, { ...existing, ...updates });
      }
    }, "local");
  }

  updateNodePosition(nodeId: string, position: { x: number; y: number }): void {
    this.doc.transact(() => {
      const existing = this.nodes.get(nodeId);
      if (existing) {
        this.nodes.set(nodeId, { ...existing, position });
      }
    }, "local");
  }

  updateNodeData(nodeId: string, data: Record<string, unknown>): void {
    this.doc.transact(() => {
      const existing = this.nodes.get(nodeId);
      if (existing) {
        this.nodes.set(nodeId, { ...existing, data: { ...existing.data, ...data } });
      }
    }, "local");
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
