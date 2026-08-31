import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { formatDistanceToNow } from "date-fns";
import type { FlowEdge, FlowNode } from "@microflow/collab";
import {
  HardDriveIcon,
  HardDriveUploadIcon,
  MoreHorizontalIcon,
  SettingsIcon,
  Share2Icon,
  Trash2Icon,
} from "lucide-react";

import { FlowThumbnail } from "@/components/home/flow-thumbnail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Icon, type IconName } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ShareFlowDialog } from "@/components/flow/dialogs/share-flow-dialog";
import { DeleteFlowDialog } from "@/components/flow/dialogs/delete-flow-dialog";

export type FlowPerson = {
  id: string;
  name: string;
  role: string;
  collabColor: string;
  collabIcon: string;
};

export type OverviewFlow = {
  id: string;
  name: string;
  updatedAt: string;
  /** Quick identifier colour, same swatch as the sidebar flow switcher. */
  color?: string | null;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** `local` is the device-only flow — it has no owner, collaborators or settings. */
  role: "owner" | "editor" | "viewer" | "local";
  people: FlowPerson[];
};

/** Quick-identifier colour, drawn as a dot beside the flow name. */
function Dot({ color, className }: { color?: string | null; className?: string }) {
  return (
    <span
      style={{ backgroundColor: color ?? "var(--foreground)" }}
      className={cn("size-2.5 shrink-0 rounded-full", className)}
    />
  );
}

/** Everyone with access to the flow, minus the signed-in user. */
export function CollaboratorFaces({
  people,
  size = 24,
}: {
  people: FlowPerson[];
  size?: number;
}) {
  if (people.length === 0) return null;

  return (
    <div className="flex -space-x-2">
      {people.slice(0, 4).map((person) => (
        <div
          key={person.id}
          title={`${person.name} · ${person.role}`}
          style={{ backgroundColor: person.collabColor, width: size, height: size }}
          className="rounded-full ring-2 ring-background text-white flex items-center justify-center"
        >
          <Icon icon={person.collabIcon as IconName} className="size-3" />
        </div>
      ))}
      {people.length > 4 && (
        <div
          style={{ width: size, height: size }}
          className="rounded-full ring-2 ring-background bg-muted text-[10px] font-medium flex items-center justify-center"
        >
          +{people.length - 4}
        </div>
      )}
    </div>
  );
}

function useOpenFlow() {
  const navigate = useNavigate();
  return (flowId: string) =>
    navigate({ to: "/flow/$flowId/graph", params: { flowId } });
}

/** The most recently edited flow, given its own row-width header. */
export function FlowSpotlight({
  flow,
  onExport,
}: {
  flow: OverviewFlow;
  onExport: () => void;
}) {
  const openFlow = useOpenFlow();
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <section className="grid md:grid-cols-2 gap-6 items-center">
      <button
        onClick={() => openFlow(flow.id)}
        className="aspect-video rounded-xl border overflow-hidden bg-background shadow-sm hover:ring-2 ring-primary/40 transition"
      >
        <ReactFlowProvider>
          <FlowThumbnail nodes={flow.nodes} edges={flow.edges} />
        </ReactFlowProvider>
      </button>
      <div className="flex flex-col gap-4">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          Continue where you left off
        </span>
        <h2 className="text-3xl font-semibold flex items-center gap-3">
          <Dot color={flow.color} className="size-3" />
          {flow.name}
        </h2>
        <div className="flex items-center gap-3">
          <CollaboratorFaces people={flow.people} size={28} />
          <span className="text-sm text-muted-foreground">
            Edited {formatDistanceToNow(flow.updatedAt, { addSuffix: true })}
          </span>
        </div>
        <div className="flex gap-2">
          <Button size="lg" onClick={() => openFlow(flow.id)}>
            Open flow
          </Button>
          {flow.role !== "local" ? (
            <Button variant="outline" size="lg" onClick={() => setShareOpen(true)}>
              <Share2Icon className="size-4 mr-2" />
              Share
            </Button>
          ) : (
            <Button variant="outline" size="lg" onClick={onExport}>
              <HardDriveUploadIcon className="size-4 mr-2" />
              Export
            </Button>
          )}
        </div>
      </div>
      {flow.role !== "local" && (
        <ShareFlowDialog
          flowId={flow.id}
          flowName={flow.name}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}
    </section>
  );
}

export function FlowCard({
  flow,
  onExport,
}: {
  flow: OverviewFlow;
  onExport: () => void;
}) {
  const navigate = useNavigate();
  const openFlow = useOpenFlow();
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const isLocal = flow.role === "local";

  return (
    <Card
      onClick={() => openFlow(flow.id)}
      className="pt-0 cursor-pointer hover:bg-muted/40 transition"
    >
      <div className="aspect-video border-b bg-background">
        <ReactFlowProvider>
          <FlowThumbnail nodes={flow.nodes} edges={flow.edges} />
        </ReactFlowProvider>
      </div>

      <CardHeader>
        <CardTitle className="flex items-center gap-2 min-w-0">
          <Dot color={flow.color} />
          <span className="truncate">{flow.name}</span>
          {isLocal && (
            <Badge variant="outline" className="gap-1 shrink-0">
              <HardDriveIcon className="size-3" />
              Local
            </Badge>
          )}
          {flow.role === "viewer" && (
            <Badge variant="secondary" className="shrink-0">
              View only
            </Badge>
          )}
          {flow.role === "editor" && (
            <Badge variant="secondary" className="shrink-0">
              Shared
            </Badge>
          )}
        </CardTitle>

        <CardDescription className="truncate">
          {isLocal
            ? "Only available on this device"
            : `Edited ${formatDistanceToNow(flow.updatedAt, { addSuffix: true })}`}
          {" \u00b7 "}
          {flow.nodes.length} nodes
        </CardDescription>

        <CardAction
          className="flex items-center gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          <CollaboratorFaces people={flow.people} size={20} />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
              <MoreHorizontalIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!isLocal && (
                <DropdownMenuItem onClick={() => setShareOpen(true)}>
                  <Share2Icon className="size-4 mr-2" />
                  Share
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onExport}>
                <HardDriveUploadIcon className="size-4 mr-2" />
                Export
              </DropdownMenuItem>
              {!isLocal && (
                <DropdownMenuItem
                  onClick={() =>
                    navigate({
                      to: "/flow/$flowId/settings",
                      params: { flowId: flow.id },
                    })
                  }
                >
                  <SettingsIcon className="size-4 mr-2" />
                  Settings
                </DropdownMenuItem>
              )}
              {flow.role === "owner" && (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => requestAnimationFrame(() => setDeleteOpen(true))}
                >
                  <Trash2Icon className="size-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {!isLocal && (
            <ShareFlowDialog
              flowId={flow.id}
              flowName={flow.name}
              open={shareOpen}
              onOpenChange={setShareOpen}
            />
          )}
          {flow.role === "owner" && (
            <DeleteFlowDialog
              flow={{ id: flow.id, name: flow.name }}
              open={deleteOpen}
              onOpenChange={setDeleteOpen}
            />
          )}
        </CardAction>
      </CardHeader>
    </Card>
  );
}

export function FlowCardSkeleton() {
  return (
    <Card className="pt-0">
      <Skeleton className="aspect-video rounded-none" />
      <CardHeader className="gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-24" />
      </CardHeader>
    </Card>
  );
}
