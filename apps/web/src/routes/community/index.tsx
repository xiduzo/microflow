import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { EarthIcon, SearchIcon } from "lucide-react";

import { trpc } from "@/lib/trpc";
import {
  CommunityFlowCard,
  type CommunityFlow,
} from "@/components/community/community-card";
import { FlowCardSkeleton } from "@/components/home/flow-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/states/empty-state";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/community/")({
  component: CommunityPage,
});

const SORTS = [
  { key: "popular", label: "Popular" },
  { key: "recent", label: "Recent" },
] as const;

type Sort = (typeof SORTS)[number]["key"];

function CommunityPage() {
  const [sort, setSort] = useState<Sort>("popular");
  const [search, setSearch] = useState("");

  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery(
      trpc.community.list.infiniteQueryOptions(
        { sort, search: search || undefined },
        { getNextPageParam: (lastPage) => lastPage.nextCursor }
      )
    );
  const flows = data?.pages.flatMap((page) => page.items) as
    | CommunityFlow[]
    | undefined;

  return (
    <div className="h-full overflow-auto flex flex-col pb-16">
      <section className="container mx-auto px-4 md:px-8 pt-8">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="mr-auto">
            <h2 className="text-xl font-semibold">Community</h2>
            <p className="text-sm text-muted-foreground">
              Flows shared by other makers — open one and copy it to make it
              your own.
            </p>
          </div>
          <div className="relative">
            <SearchIcon className="size-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search community flows"
              className="pl-8 w-full sm:w-56"
            />
          </div>
        </div>

        <div className="flex gap-1 mb-2">
          {SORTS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setSort(key)}
              className={cn(
                "px-3 py-1.5 text-sm rounded-md",
                sort === key
                  ? "bg-muted font-medium"
                  : "text-muted-foreground hover:bg-muted/50"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]">
          {isLoading && (
            <>
              <FlowCardSkeleton />
              <FlowCardSkeleton />
              <FlowCardSkeleton />
            </>
          )}
          {flows?.map((flow) => (
            <CommunityFlowCard key={flow.id} flow={flow} />
          ))}
        </div>

        {hasNextPage && (
          <div className="flex justify-center mt-6">
            <Button
              variant="outline"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}

        {!isLoading && !flows?.length && (
          <EmptyState
            title={search ? "No flows match" : "Nothing shared yet"}
            description={
              search
                ? "Try a different search."
                : "Be the first — publish one of your flows from its share dialog."
            }
            icon={EarthIcon}
          />
        )}
      </section>
    </div>
  );
}
