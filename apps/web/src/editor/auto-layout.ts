// Arrange a flow left-to-right, the way you would have drawn it by hand.
//
// One layered layout used by both callers, so the dock button and Ask AI cannot
// disagree about what "tidy" means. Dagre because a flow is a layered graph
// with crossings to minimise, which is not a few lines of our own code.
//
// Pure: takes nodes and edges, returns positions. The caller writes them.

import dagre from "@dagrejs/dagre";
import type { FlowEdge, FlowNode } from "@microflow/collab";

/** What a node measures when ReactFlow has not reported it yet (`min-w-80`
 *  plus a typical body). Only affects spacing, never correctness. */
const FALLBACK_WIDTH = 320;
const FALLBACK_HEIGHT = 220;

/** Gaps between nodes. Roomy on purpose — these nodes carry a live value
 *  readout and edges animate, and both are unreadable when packed. */
const RANK_GAP = 160; // between columns (along the flow)
const NODE_GAP = 80; // between nodes sharing a column

type Positioned = { id: string; position: { x: number; y: number } };

/**
 * Lay out `nodes` as columns of dependency depth, left to right.
 *
 * Nodes with no edges still get placed — dagre puts them in their own
 * component — so a half-built flow tidies up rather than half-tidying.
 */
export function autoLayout(nodes: FlowNode[], edges: FlowEdge[]): Positioned[] {
  if (nodes.length === 0) return [];

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", ranksep: RANK_GAP, nodesep: NODE_GAP });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    graph.setNode(node.id, {
      width: node.width ?? FALLBACK_WIDTH,
      height: node.height ?? FALLBACK_HEIGHT,
    });
  }
  for (const edge of edges) {
    // An edge to a node that is gone would make dagre invent it at 0×0.
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(graph);

  // Dagre centres each node; ReactFlow positions by top-left.
  return nodes.map((node) => {
    const laid = graph.node(node.id);
    return {
      id: node.id,
      position: {
        x: Math.round(laid.x - laid.width / 2),
        y: Math.round(laid.y - laid.height / 2),
      },
    };
  });
}

/** The document side of the same operation: lay out and write the moves as one
 *  undo step. Exported because both the dock and the AI tools want exactly this. */
export function applyAutoLayout(doc: {
  getNodes: () => FlowNode[];
  getEdges: () => FlowEdge[];
  updateNodePosition: (id: string, position: { x: number; y: number }) => void;
  doc: { transact: (fn: () => void, origin: string) => void };
}): void {
  const laid = autoLayout(doc.getNodes(), doc.getEdges());
  if (laid.length === 0) return;
  doc.doc.transact(() => {
    for (const { id, position } of laid) doc.updateNodePosition(id, position);
  }, "local");
}
