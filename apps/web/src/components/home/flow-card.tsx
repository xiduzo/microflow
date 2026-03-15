import { useEffect } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  useReactFlow,
  useNodesInitialized,
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
import { useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { HardDriveUploadIcon, SettingsIcon } from "lucide-react";
import { NODE_TYPES } from "../flow/nodes/_TYPES";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { Button } from "../ui/button";

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
  beforeNavigate?: () => Promise<void>;
  onExport?: () => void;
  /** When set, show a Settings action that navigates to this flow's settings (e.g. for non-local flows) */
  settingsFlowId?: string;
};

export function FlowCard(props: FlowCardProps) {
  const navigate = useNavigate();

  async function handleClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("[data-card-action]")) return;
    await props.beforeNavigate?.();
    navigate({ to: "/flow/$flowId/graph", params: { flowId: props.id } });
  }

  return (
    <Card className="overflow-hidden transition-all hover:ring-2 hover:ring-primary/50 h-full pt-0 group relative hover:cursor-pointer" onClick={handleClick}>
      <CardContent className="px-0 mb-4">
        <div className="aspect-4/3 bg-muted/30 relative overflow-hidden">
          <ReactFlowProvider>
            <FlowThumbnail nodes={props.nodes} edges={props.edges} />
          </ReactFlowProvider>
          {(props.onExport || props.settingsFlowId) && (
            <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" data-card-action>
              {props.settingsFlowId && (
                <Button
                  variant="secondary"
                  size="icon"
                  className="size-8 shadow-md"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate({
                      to: "/flow/$flowId/settings",
                      params: { flowId: props.settingsFlowId! },
                    });
                  }}
                  title="Flow settings"
                >
                  <SettingsIcon className="size-4" />
                </Button>
              )}
              {props.onExport && (
                <Button
                  variant="secondary"
                  size="icon"
                  className="size-8 shadow-md"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onExport?.();
                  }}
                  title="Export flow"
                >
                  <HardDriveUploadIcon className="size-4" />
                </Button>
              )}
            </div>
          )}
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

function FitViewOnInit() {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();

  useEffect(() => {
    if (nodesInitialized) {
      fitView({ padding: 0.15, minZoom: 0.05, maxZoom: 1 });
    }
  }, [nodesInitialized, fitView]);

  return null;
}

export function FlowThumbnail({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
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
      <FitViewOnInit />
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
