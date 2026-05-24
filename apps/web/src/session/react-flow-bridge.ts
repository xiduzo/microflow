import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import type { FlowDocument, FlowEdge, FlowNode } from "@microflow/collab";

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

  /** Skip the Y.Doc write when position + dimensions are unchanged. */
  static nodeNeedsWrite(local: FlowNode, yjs: FlowNode | undefined): boolean {
    if (!yjs) return true;
    return (
      local.position.x !== yjs.position.x ||
      local.position.y !== yjs.position.y ||
      local.width !== yjs.width ||
      local.height !== yjs.height
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

  /** True only inside our own `transact("local")` to suppress echo. */
  private isFlushingToDoc = false;
  private destroyed = false;

  constructor(doc: FlowDocument) {
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
    if (changes.some((c) => ReactFlowBridge.classifyNodeChange(c) === "structural")) {
      this.hasPendingNodeWrite = true;
      this.scheduleFlush();
    }
  }

  applyEdgeChanges(changes: EdgeChange[]): void {
    if (this.destroyed) return;
    const next = applyEdgeChanges(changes, this.currentSnapshot.edges) as FlowEdge[];
    this.setSnapshot({ ...this.currentSnapshot, edges: next });
    if (changes.some((c) => ReactFlowBridge.classifyEdgeChange(c) === "structural")) {
      this.hasPendingEdgeWrite = true;
      this.scheduleFlush();
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

    this.isFlushingToDoc = true;
    try {
      this.doc.doc.transact(() => {
        if (writeNodes) this.writeNodesToDoc(this.currentSnapshot.nodes);
        if (writeEdges) this.writeEdgesToDoc(this.currentSnapshot.edges);
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
    this.setSnapshot({ ...this.currentSnapshot, nodes: merged });
  };

  private handleYjsEdgesChange = (): void => {
    if (this.isFlushingToDoc || this.destroyed) return;
    const merged = ReactFlowBridge.mergeEdgesYjsIntoSnapshot(
      this.doc.getEdges(),
      this.currentSnapshot.edges,
    );
    this.setSnapshot({ ...this.currentSnapshot, edges: merged });
  };

  /** Preserve local-only fields (`selected`, `dragging`) when merging an
   * incoming Y.Doc snapshot over the current React snapshot. */
  static mergeYjsIntoSnapshot(yjsNodes: FlowNode[], currentLocal: FlowNode[]): FlowNode[] {
    const localMap = new Map(currentLocal.map((n) => [n.id, n]));
    return yjsNodes.map((yjsNode) => {
      const local = localMap.get(yjsNode.id);
      return {
        ...yjsNode,
        selected: local?.selected,
        dragging: local?.dragging,
      };
    });
  }

  /** Edge equivalent — only `selected` is local-only. */
  static mergeEdgesYjsIntoSnapshot(yjsEdges: FlowEdge[], currentLocal: FlowEdge[]): FlowEdge[] {
    const localMap = new Map(currentLocal.map((e) => [e.id, e]));
    return yjsEdges.map((yjsEdge) => {
      const local = localMap.get(yjsEdge.id);
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

  private writeNodesToDoc(localNodes: FlowNode[]): void {
    const yMap = this.doc.nodes;
    const currentIds = new Set(yMap.keys());
    const nextIds = new Set(localNodes.map((n) => n.id));

    for (const id of currentIds) {
      if (!nextIds.has(id)) yMap.delete(id);
    }
    for (const node of localNodes) {
      const existing = yMap.get(node.id);
      if (!ReactFlowBridge.nodeNeedsWrite(node, existing)) continue;
      yMap.set(node.id, { ...node, selected: undefined, dragging: undefined });
    }
  }

  private writeEdgesToDoc(localEdges: FlowEdge[]): void {
    const yMap = this.doc.edges;
    const currentIds = new Set(yMap.keys());
    const nextIds = new Set(localEdges.map((e) => e.id));

    for (const id of currentIds) {
      if (!nextIds.has(id)) yMap.delete(id);
    }
    for (const edge of localEdges) {
      if (yMap.has(edge.id)) continue;
      yMap.set(edge.id, { ...edge, selected: undefined });
    }
  }
}
