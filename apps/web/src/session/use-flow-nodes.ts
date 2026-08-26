import { useEffect, useRef, useState } from "react";
import type { FlowDocument, FlowNode, FlowEdge } from "@microflow/collab";
import { flowStructureKey } from "@microflow/collab/schema";

export function useFlowNodes(doc: FlowDocument): FlowNode[] {
  const [nodes, setNodes] = useState<FlowNode[]>(() => doc.getNodes());
  useEffect(() => {
    setNodes(doc.getNodes());
    return doc.onNodesChange(() => setNodes(doc.getNodes()));
  }, [doc]);
  return nodes;
}

/**
 * The doc's nodes with a **structural** identity: the returned array keeps its
 * reference until the Flow's structure changes (see `projectFlowStructure` —
 * node ids/types/config data, with layout stripped). Moving or selecting a Node
 * still fires the Yjs observer, but re-renders nothing here, so consumers keyed
 * on the array do no work.
 *
 * Use this instead of {@link useFlowNodes} whenever the consumer derives
 * something the layout cannot affect (a netlist, a sketch). The trade-off is
 * the mirror image: the retained array carries the positions from the last
 * structural change, so it must never be used to draw the Flow.
 */
export function useFlowStructuralNodes(doc: FlowDocument): FlowNode[] {
  const [nodes, setNodes] = useState<FlowNode[]>(() => doc.getNodes());
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    const sync = () => {
      const next = doc.getNodes();
      const key = flowStructureKey(next);
      if (key === keyRef.current) return;
      keyRef.current = key;
      setNodes(next);
    };
    sync();
    return doc.onNodesChange(sync);
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
