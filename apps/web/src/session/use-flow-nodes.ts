import { useEffect, useState } from "react";
import type { FlowDocument, FlowNode, FlowEdge } from "@microflow/collab";

export function useFlowNodes(doc: FlowDocument): FlowNode[] {
  const [nodes, setNodes] = useState<FlowNode[]>(() => doc.getNodes());
  useEffect(() => {
    setNodes(doc.getNodes());
    return doc.onNodesChange(() => setNodes(doc.getNodes()));
  }, [doc]);
  return nodes;
}

export function useFlowEdges(doc: FlowDocument): FlowEdge[] {
  const [edges, setEdges] = useState<FlowEdge[]>(() => doc.getEdges());
  useEffect(() => {
    setEdges(doc.getEdges());
    return doc.onEdgesChange(() => setEdges(doc.getEdges()));
  }, [doc]);
  return edges;
}
