import { useEffect } from "react";
import {
  ReactFlow,
  Background,
  useReactFlow,
  useStore,
  type Node,
  type Edge,
} from "@xyflow/react";
import { NODE_TYPES } from "../flow/nodes/_REGISTRY";
import { PreviewFlowSessionProvider } from "@/session";
import type { FlowEdge, FlowNode } from "@microflow/collab";

/**
 * Node bodies (icons, leva controls, canvases) mount after the node is first
 * measured, so a card keeps growing past the initial fit and spills out of the
 * thumbnail. Refit whenever the measured bounds change.
 */
function RefitOnResize() {
  const { fitView } = useReactFlow();
  const measured = useStore((state) =>
    Array.from(state.nodeLookup.values())
      .map((node) => `${node.measured?.width}x${node.measured?.height}`)
      .join(),
  );

  useEffect(() => {
    fitView({ padding: 0.15 });
  }, [measured, fitView]);

  return null;
}

export function FlowThumbnail({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  return (
    <PreviewFlowSessionProvider nodes={nodes as FlowNode[]} edges={edges as FlowEdge[]}>
      <ReactFlow
        // `defaultNodes` is read once per mount, so a thumbnail first rendered
        // while its flow is still loading would stay empty forever. Remount
        // when the graph identity changes.
        key={nodes.map((node) => node.id).join()}
        // Uncontrolled: a controlled `nodes` prop without `onNodesChange` throws
        // away the measured node dimensions, so fitView frames zero-width nodes
        // and lands on the top-left corner instead of the whole graph.
        defaultNodes={nodes}
        defaultEdges={edges}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        // The instance minZoom clamps fitView too — the default 0.5 makes a
        // multi-node graph unfittable in a thumbnail-sized box.
        minZoom={0.05}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }} // Sorry - proper attribution is given on the main page
        className="pointer-events-none"
        nodeTypes={NODE_TYPES}
      >
        <RefitOnResize />
        <Background gap={20} size={1} className="opacity-30" />
      </ReactFlow>
    </PreviewFlowSessionProvider>
  );
}
