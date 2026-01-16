import * as Y from "yjs";

export type FlowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  measured?: { width: number; height: number };
  selected?: boolean;
};

export type FlowEdge = {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
  type?: string;
};

export type FlowData = {
  nodes: FlowNode[];
  edges: FlowEdge[];
};

/**
 * Encode a Yjs document to a Uint8Array for database storage
 */
export function encodeYDoc(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Decode a Uint8Array from the database into a Yjs document
 */
export function decodeYDoc(data: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, data);
  return doc;
}

/**
 * Create a new Yjs document with empty flow structure
 */
export function createEmptyFlowDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.getArray("nodes");
  doc.getArray("edges");
  return doc;
}

/**
 * Get flow data (nodes/edges) from a Yjs document
 */
export function getFlowData(doc: Y.Doc): FlowData {
  const nodes = doc.getArray<FlowNode>("nodes").toArray();
  const edges = doc.getArray<FlowEdge>("edges").toArray();
  return { nodes, edges };
}

/**
 * Set flow data in a Yjs document (replaces existing data)
 */
export function setFlowData(doc: Y.Doc, data: FlowData): void {
  const yNodes = doc.getArray<FlowNode>("nodes");
  const yEdges = doc.getArray<FlowEdge>("edges");

  doc.transact(() => {
    yNodes.delete(0, yNodes.length);
    yEdges.delete(0, yEdges.length);
    yNodes.push(data.nodes);
    yEdges.push(data.edges);
  });
}
