import { Link, useNavigate } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookmarkIcon, GitForkIcon } from "lucide-react";
import { toast } from "sonner";
import type { FlowEdge, FlowNode } from "@microflow/collab";

import { trpc } from "@/lib/trpc";
import { authClient } from "@/lib/auth-client";
import { FlowThumbnail } from "@/components/home/flow-thumbnail";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type CommunityAuthor = {
  id: string;
  name: string;
  image: string | null;
  collabColor: string;
  collabIcon: string;
};

/** A published flow as the community endpoints return it. */
export type CommunityFlow = {
  id: string;
  name: string;
  color?: string | null;
  description: string | null;
  publishedAt: string | Date | null;
  nodes: FlowNode[];
  edges: FlowEdge[];
  author: CommunityAuthor;
  isOwn: boolean;
  bookmarkCount: number;
  forkCount: number;
  bookmarked: boolean;
};

/** Invalidate every query that renders bookmark state. */
export function useToggleBookmark() {
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const isSignedIn = !!session?.user;

  const mutation = useMutation(
    trpc.community.toggleBookmark.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.community.pathKey() });
      },
      onError: (error) => toast.error(error.message),
    })
  );

  return (flowId: string) => {
    if (!isSignedIn) {
      toast.info("Sign in to bookmark flows");
      return;
    }
    mutation.mutate({ flowId });
  };
}

export function BookmarkButton({
  flow,
  size = "sm",
}: {
  flow: CommunityFlow;
  size?: "sm" | "lg";
}) {
  const toggleBookmark = useToggleBookmark();

  return (
    <Button
      variant="outline"
      size={size}
      onClick={(event) => {
        event.stopPropagation();
        toggleBookmark(flow.id);
      }}
      title={flow.bookmarked ? "Remove bookmark" : "Bookmark this flow"}
    >
      <BookmarkIcon
        className={cn("size-4", flow.bookmarked && "fill-current")}
      />
      <span className="tabular-nums">{flow.bookmarkCount}</span>
    </Button>
  );
}

/** The identity users configure in their settings — same as collaborator faces. */
export function CollabFace({
  author,
  size = 20,
  iconClassName = "size-3",
}: {
  author: CommunityAuthor;
  size?: number;
  iconClassName?: string;
}) {
  return (
    <div
      title={author.name}
      style={{ backgroundColor: author.collabColor, width: size, height: size }}
      className="shrink-0 rounded-full text-white flex items-center justify-center"
    >
      <Icon icon={author.collabIcon as IconName} className={iconClassName} />
    </div>
  );
}

export function AuthorLink({
  author,
  className,
}: {
  author: CommunityAuthor;
  className?: string;
}) {
  return (
    <Link
      to="/u/$userId"
      params={{ userId: author.id }}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "flex items-center gap-1.5 min-w-0 hover:underline",
        className
      )}
    >
      <CollabFace author={author} />
      <span className="truncate">{author.name}</span>
    </Link>
  );
}

export function CommunityFlowCard({ flow }: { flow: CommunityFlow }) {
  const navigate = useNavigate();

  return (
    <Card
      onClick={() =>
        navigate({ to: "/community/$flowId", params: { flowId: flow.id } })
      }
      className="pt-0 cursor-pointer hover:bg-muted/40 transition"
    >
      <div className="aspect-video border-b bg-background">
        <ReactFlowProvider>
          <FlowThumbnail nodes={flow.nodes} edges={flow.edges} />
        </ReactFlowProvider>
      </div>

      <CardHeader>
        <CardTitle className="flex items-center gap-2 min-w-0">
          <span
            style={{ backgroundColor: flow.color ?? "var(--foreground)" }}
            className="size-2.5 shrink-0 rounded-full"
          />
          <span className="truncate">{flow.name}</span>
        </CardTitle>

        {flow.description && (
          <CardDescription className="line-clamp-2">
            {flow.description}
          </CardDescription>
        )}

        <div
          className="flex items-center gap-3 text-sm text-muted-foreground pt-1"
          onClick={(event) => event.stopPropagation()}
        >
          <AuthorLink author={flow.author} className="mr-auto" />
          <span
            className="flex items-center gap-1 tabular-nums"
            title={`Copied ${flow.forkCount} times`}
          >
            <GitForkIcon className="size-3.5" />
            {flow.forkCount}
          </span>
          <BookmarkButton flow={flow} />
        </div>
      </CardHeader>
    </Card>
  );
}
