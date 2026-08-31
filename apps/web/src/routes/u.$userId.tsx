import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import { EarthIcon } from "lucide-react";

import { trpc } from "@/lib/trpc";
import {
  CollabFace,
  CommunityFlowCard,
  type CommunityAuthor,
  type CommunityFlow,
} from "@/components/community/community-card";
import { FlowCardSkeleton } from "@/components/home/flow-list";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/states/empty-state";

export const Route = createFileRoute("/u/$userId")({
  component: PublicProfilePage,
});

function PublicProfilePage() {
  const { userId } = Route.useParams();
  const {
    data,
    isLoading,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(
    trpc.community.byAuthor.infiniteQueryOptions(
      { userId },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    )
  );

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        This user does not exist.
      </div>
    );
  }

  const author = data?.pages[0]?.author as CommunityAuthor & { createdAt: string | Date };
  const total = data?.pages[0]?.total ?? 0;
  const flows = data?.pages.flatMap((page) => page.items) as
    | CommunityFlow[]
    | undefined;

  return (
    <div className="h-full overflow-auto flex flex-col pb-16">
      <section className="container mx-auto px-4 md:px-8 pt-8">
        {author && (
          <div className="flex items-center gap-4 mb-8">
            <CollabFace author={author} size={64} iconClassName="size-8" />
            <div>
              <h1 className="text-2xl font-semibold">{author.name}</h1>
              <p className="text-sm text-muted-foreground">
                Member since {format(author.createdAt, "MMMM yyyy")}
                {" · "}
                {total} shared {total === 1 ? "flow" : "flows"}
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]">
          {isLoading && (
            <>
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
            title="Nothing shared yet"
            description="This maker hasn't published any flows to the community."
            icon={EarthIcon}
          />
        )}
      </section>
    </div>
  );
}
