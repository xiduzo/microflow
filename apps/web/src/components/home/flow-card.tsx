import { useEffect, useState } from "react";
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
  CardAction,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { HardDriveUploadIcon, MoreHorizontalIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { NODE_TYPES } from "../flow/nodes/_TYPES";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { Button } from "../ui/button";
import { DeleteFlowDialog } from "../flow/dialogs/delete-flow-dialog";

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
  /** When set, show a Delete action in the dropdown menu */
  deleteFlow?: { id: string; name: string };
};

export function FlowCard(props: FlowCardProps) {
  const navigate = useNavigate();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  async function handleClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("[data-card-action]")) return;
    await props.beforeNavigate?.();
    navigate({ to: "/flow/$flowId/graph", params: { flowId: props.id } });
  }

  const hasActions = !!(props.onExport || props.settingsFlowId || props.deleteFlow);

  return (
    <Card className="relative mx-auto w-full pt-0">
      <section className="relative z-20 aspect-video w-full overflow-hidden bg-background">
        <ReactFlowProvider>
          <FlowThumbnail nodes={props.nodes} edges={props.edges} />
        </ReactFlowProvider>
      </section>
      <CardHeader>
        {props.badges && props.badges.length > 0 && (
          <CardAction>
            {props.badges.map((badge) => (
              <Badge key={badge.label} variant={badge.variant}>
                {badge.label}
              </Badge>
            ))}
          </CardAction>
        )}
        <CardTitle>{props.name}</CardTitle>
        <CardDescription>
          {props.description
            ? props.description
            : `Edited ${formatDistanceToNow(props.updatedAt, { addSuffix: true })}`}
        </CardDescription>
      </CardHeader>
      <CardFooter className="gap-2">
        <Button className="flex-1" onClick={handleClick}>Open flow</Button>
        {hasActions && (
          <DropdownMenu>
            <DropdownMenuTrigger>
              <Button variant="outline" size="icon" data-card-action>
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {props.onExport && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); props.onExport?.(); }}>
                  <HardDriveUploadIcon className="size-4 mr-2" />
                  Export
                </DropdownMenuItem>
              )}
              {props.settingsFlowId && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate({ to: "/flow/$flowId/settings", params: { flowId: props.settingsFlowId! } });
                  }}
                >
                  <SettingsIcon className="size-4 mr-2" />
                  Settings
                </DropdownMenuItem>
              )}
              {props.deleteFlow && (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    // Delay to let the dropdown finish closing before opening the dialog
                    requestAnimationFrame(() => setDeleteDialogOpen(true));
                  }}
                >
                  <Trash2Icon className="size-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </CardFooter>
      {props.deleteFlow && (
        <DeleteFlowDialog
          flow={props.deleteFlow}
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
        />
      )}
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
    <Card className="relative mx-auto w-full pt-0">
      <section className="aspect-video w-full overflow-hidden">
        <Skeleton className="h-full w-full rounded-none" />
      </section>
      <CardHeader>
        <CardTitle>
          <Skeleton className="h-4 w-3/4" />
        </CardTitle>
        <CardDescription>
          <Skeleton className="h-3 w-1/2" />
        </CardDescription>
      </CardHeader>
      <CardFooter>
        <Skeleton className="h-9 w-full" />
      </CardFooter>
    </Card>
  );
}
