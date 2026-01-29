import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  type Node,
  type Edge,
} from "@xyflow/react";
import {
  Card,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Link, useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { NODE_TYPES } from "../flow/nodes/_TYPES";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";

type FlowCardProps = {
  id: string;
  name: string;
  description?: string | null;
  updatedAt: string;
  nodes: Node[];
  edges: Edge[];
  badges?: {
    label: string;
    variant: "secondary" | "destructive" | "outline" | "default";
  }[];
  beforeNavigate?: () => Promise<void>
};

export function FlowCard(props: FlowCardProps) {
  const navigate = useNavigate();

  async function handleClick() {
    await props.beforeNavigate?.()
    navigate({ to: "/flow/$flowId/graph", params: { flowId: props.id } })
  }

  return (
    <Card className="overflow-hidden transition-all hover:ring-2 hover:ring-primary/50 h-full pt-0 group relative hover:cursor-pointer" onClick={handleClick}>
      <CardContent className="px-0 mb-4">
        <div className="aspect-4/3 bg-muted/30 relative overflow-hidden">
          <ReactFlowProvider>
            <FlowThumbnail nodes={props.nodes} edges={props.edges} />
          </ReactFlowProvider>
        </div>
      </CardContent>
      <CardHeader>
        <CardTitle className="truncate group-hover:text-primary transition-colors">
          {props.name}
        </CardTitle>
        <CardDescription>
          {props.description && <p className="text-xs text-muted-foreground">{props.description}</p>}
          {!props.description && <p className="text-xs text-muted-foreground">Edited {formatDistanceToNow(props.updatedAt, { addSuffix: true })}</p>}
        </CardDescription>
      </CardHeader>
      <CardFooter className="gap-2 flex flex-wrap">
        {props.badges?.map((badge) => (
          <Badge key={badge.label} variant={badge.variant}>
            {badge.label}
          </Badge>
        ))}
      </CardFooter>
    </Card>
  );
}

function FlowThumbnail({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      fitViewOptions={{ padding: 0.15, minZoom: 0.05, maxZoom: 1 }}
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
      <Background gap={20} size={1} className="opacity-30" />
    </ReactFlow>
  );
}

export function FlowCardSkeleton() {
  return (
    <Card className="overflow-hidden transition-all hover:ring-2 hover:ring-primary/50 h-full pt-0">
      <CardContent className="px-0 mb-2">
        <Skeleton className="aspect-4/3 rounded-none" />
      </CardContent>
      <CardHeader>
        <CardTitle>
          <Skeleton className="h-4 w-3/4" />
        </CardTitle>
        <CardDescription>
          <Skeleton className="h-3 w-1/2" />
        </CardDescription>
      </CardHeader>
      <CardFooter className="gap-2">
        <Skeleton className="h-5 w-16" />
        {Math.random() > 0.7 && <Skeleton className="h-5 w-16" />}
      </CardFooter>
    </Card>
  );
}
