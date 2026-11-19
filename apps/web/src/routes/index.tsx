import { useEffect, useMemo, useState } from "react";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { User2Icon, HardDriveDownloadIcon, Plus, SearchIcon } from "lucide-react";
import { compareDesc } from "date-fns";
import { toast } from "sonner";

import { trpc } from "@/lib/trpc";
import { reportError } from "@/lib/report-error";
import { authClient } from "@/account/auth-client";
import {
  FlowCard,
  FlowCardSkeleton,
  FlowSpotlight,
  type OverviewFlow,
} from "@/flows/flow-list";
import {
  CommunityFlowCard,
  type CommunityFlow,
} from "@/community/community-card";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { CreateFlowDialog } from "@/flows/create-flow-dialog";
import { EmptyState } from "@/ui/states/empty-state";
import { exportFlowData, useImportFlow } from "@/flows/use-flow-import-export";
import { loadLocalFlow } from "@/session";
import { cn } from "@/ui/utils";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

const SCOPES = [
  { key: "all", label: "All" },
  { key: "mine", label: "Mine" },
  { key: "shared", label: "Shared with me" },
  { key: "bookmarked", label: "Bookmarked" },
] as const;

type Scope = (typeof SCOPES)[number]["key"];

function HomeComponent() {
  const { data: session } = authClient.useSession();
  const isSignedIn = !!session?.user;
  const importFlow = useImportFlow(Route.id);

  const [scope, setScope] = useState<Scope>("all");
  const [search, setSearch] = useState("");

  // Read the local flow from its Yjs document, so the card previews what the
  // editor will actually open rather than the last visited flow.
  const [localContents, setLocalContents] = useState<{
    nodes: OverviewFlow["nodes"];
    edges: OverviewFlow["edges"];
  }>({ nodes: [], edges: [] });

  useEffect(() => {
    loadLocalFlow()
      .then(setLocalContents)
      // The preview stays empty; the failure itself is already reported by the adapter.
      .catch((e) => reportError(e, { source: "action", route: Route.id }));
  }, []);

  const localFlow = useMemo<OverviewFlow>(
    () => ({
      id: "local",
      name: "Local Flow",
      updatedAt: new Date().toISOString(),
      nodes: localContents.nodes,
      edges: localContents.edges,
      role: "local",
      people: [],
    }),
    [localContents],
  );

  const { data, isLoading } = useQuery({
    ...trpc.flow.list.queryOptions(),
    enabled: isSignedIn,
  });

  const {
    data: bookmarkedData,
    isLoading: bookmarkedLoading,
    hasNextPage: bookmarkedHasMore,
    fetchNextPage: fetchMoreBookmarked,
    isFetchingNextPage: fetchingMoreBookmarked,
  } = useInfiniteQuery({
    ...trpc.community.bookmarks.infiniteQueryOptions(
      {},
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    ),
    enabled: isSignedIn && scope === "bookmarked",
  });
  const bookmarked = bookmarkedData?.pages.flatMap((page) => page.items) as
    | CommunityFlow[]
    | undefined;

  const flows = useMemo<OverviewFlow[]>(() => {
    const cloud: OverviewFlow[] = [
      ...(data?.owned ?? []).map((flow) => ({ ...flow, role: "owner" as const })),
      ...(data?.collaborated ?? []).map((flow) => ({
        ...flow,
        role: flow.role === "viewer" ? ("viewer" as const) : ("editor" as const),
      })),
    ];
    return [
      ...cloud.sort((a, b) => compareDesc(a.updatedAt, b.updatedAt)),
      localFlow,
    ];
  }, [data, localFlow]);

  const exportHandler = (flow: OverviewFlow) => () => {
    exportFlowData(
      { name: flow.name, updatedAt: new Date(flow.updatedAt).getTime() },
      { nodes: flow.nodes, edges: flow.edges }
    );
    toast.success("Flow exported");
  };

  const spotlight = flows[0];
  const visible = flows.filter((flow) => {
    if (scope === "mine" && !(flow.role === "owner" || flow.role === "local"))
      return false;
    if (scope === "shared" && (flow.role === "owner" || flow.role === "local"))
      return false;
    return flow.name.toLowerCase().includes(search.toLowerCase().trim());
  });

  return (
    <div className="h-full overflow-auto flex flex-col pb-16">
      <section className="container mx-auto px-4 md:px-8 pt-8 flex flex-col gap-10">
        {spotlight && (
          <FlowSpotlight flow={spotlight} onExport={exportHandler(spotlight)} />
        )}

        <section>
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <h2 className="text-xl font-semibold mr-auto">My Flows</h2>
            <div className="relative">
              <SearchIcon className="size-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search flows"
                className="pl-8 w-full sm:w-56"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={importFlow}
            >
              <HardDriveDownloadIcon className="size-4 mr-2" />
              Import
            </Button>
            <CreateFlowDialog
              trigger={
                <Button size="sm">
                  <Plus className="size-4 mr-2" />
                  New Flow
                </Button>
              }
            />
          </div>

          {isSignedIn && (
            <div className="flex gap-1 mb-2">
              {SCOPES.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setScope(key)}
                  className={cn(
                    "px-3 py-1.5 text-sm rounded-md",
                    scope === key
                      ? "bg-muted font-medium"
                      : "text-muted-foreground hover:bg-muted/50"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {scope === "bookmarked" ? (
            <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]">
              {bookmarkedLoading && <FlowCardSkeleton />}
              {bookmarked
                ?.filter((flow) =>
                  flow.name.toLowerCase().includes(search.toLowerCase().trim())
                )
                .map((flow) => (
                  <CommunityFlowCard key={flow.id} flow={flow} />
                ))}
              {bookmarkedHasMore && (
                <div className="col-span-full flex justify-center">
                  <Button
                    variant="outline"
                    onClick={() => fetchMoreBookmarked()}
                    disabled={fetchingMoreBookmarked}
                  >
                    {fetchingMoreBookmarked ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
              {!bookmarkedLoading && !bookmarked?.length && (
                <p className="col-span-full p-10 text-center text-sm text-muted-foreground">
                  Nothing bookmarked yet — find flows to save in the{" "}
                  <Link to="/community" className="underline">
                    community
                  </Link>
                  .
                </p>
              )}
            </div>
          ) : (
            <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]">
              {isSignedIn && isLoading && (
                <>
                  <FlowCardSkeleton />
                  <FlowCardSkeleton />
                  <FlowCardSkeleton />
                </>
              )}
              {visible.map((flow) => (
                <FlowCard
                  key={flow.id}
                  flow={flow}
                  onExport={exportHandler(flow)}
                />
              ))}
              {!visible.length && !isLoading && (
                <p className="col-span-full p-10 text-center text-sm text-muted-foreground">
                  No flows match.
                </p>
              )}
            </div>
          )}
        </section>
      </section>
      {!isSignedIn && <SignInNudge />}
    </div>
  );
}

function SignInNudge() {
  return (
    <EmptyState
      title="Not signed in"
      description="Sign in to create multiple flows and collaborate with others"
      icon={User2Icon}
    >
      <Link to="/login">
        <Button>Sign in</Button>
      </Link>
    </EmptyState>
  );
}
