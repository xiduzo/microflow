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
  CardAction,
} from "@/components/ui/card";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { CloudIcon, HardDriveIcon, UsersIcon } from "lucide-react";
import { NODE_TYPES } from "../flow/nodes/_TYPES";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";

type FlowCardProps = {
  id: string;
  name: string;
  updatedAt: string;
  nodes: Node[];
  edges: Edge[];
  isLocal?: boolean;
  isOwner?: boolean;
  role?: string;
};

export function FlowCard({
  id,
  name,
  updatedAt,
  nodes,
  edges,
  isLocal,
  isOwner,
  role,
}: FlowCardProps) {
  const linkTo = isLocal ? "/flow" : `/flow?id=${id}`;

  return (
    <Link to={linkTo} className="block group">
      <Card className="overflow-hidden transition-all hover:ring-2 hover:ring-primary/50 h-full pt-0">
        <CardContent className="p-0">
          <div className="aspect-4/3 bg-muted/30 relative overflow-hidden">
            <ReactFlowProvider>
              <FlowThumbnail nodes={nodes} edges={edges} />
            </ReactFlowProvider>
          </div>
        </CardContent>
        <CardHeader className="pb-2">
          <CardTitle className="truncate group-hover:text-primary transition-colors">
            {name}
          </CardTitle>
          <CardDescription>
            Edited {formatDistanceToNow(updatedAt, { addSuffix: true })}
          </CardDescription>
        </CardHeader>
        <CardFooter className="gap-2">
          {isLocal && <Badge>Not synced to cloud</Badge>}
          {!isLocal && isOwner && <Badge>owner</Badge>}
          {role && <Badge>{role}</Badge>}
        </CardFooter>
      </Card>
    </Link>
  );
}

function FlowThumbnail({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      fitViewOptions={{ padding: 0.15, minZoom: 0.05, maxZoom: 1 }}
      minZoom={0.0001}
      maxZoom={1}
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
      proOptions={{ hideAttribution: true }}
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
      <CardContent className="p-0">
        <Skeleton className="aspect-4/3 rounded-none" />
      </CardContent>
      <CardHeader className="pb-2">
        <CardTitle className="truncate group-hover:text-primary transition-colors">
          <Skeleton className="h-4 w-3/4" />
        </CardTitle>
        <CardDescription>
          <Skeleton className="h-3 w-1/2" />
        </CardDescription>
      </CardHeader>
      <CardFooter className="gap-2">
        <Skeleton className="h-4 w-1/4" />
      </CardFooter>
    </Card>
  );
}
