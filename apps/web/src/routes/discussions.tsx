import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CircleCheckIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PlusIcon,
  ThumbsUpIcon,
} from "lucide-react";

import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/states/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { openExternal } from "@/lib/docs";
import {
  CONTRIBUTION_WAYS,
  DISCUSSIONS_URL,
  newDiscussionUrl,
  wayDiscussionUrl,
} from "@/lib/contribute";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/discussions")({
  component: DiscussionsPage,
});

const ALL = "all";

function relativeDay(iso: string | null): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

function DiscussionsPage() {
  const [category, setCategory] = useState<string>(ALL);

  const { data, isLoading } = useQuery({
    ...trpc.discussions.list.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });
  const discussions = data?.discussions ?? [];

  const categories = [...new Set(discussions.map((d) => d.category.slug))].map(
    (slug) => {
      const meta = discussions.find((d) => d.category.slug === slug)!.category;
      return { slug, name: meta.name, emoji: meta.emoji };
    },
  );
  const shown =
    category === ALL
      ? discussions
      : discussions.filter((d) => d.category.slug === category);

  return (
    <div className="h-full w-full overflow-y-auto">
      <main className="mx-auto w-full max-w-3xl px-4 py-16">
        <header className="flex flex-wrap items-start gap-4">
          <div className="mr-auto">
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Discussions
            </h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              Every way to help Microflow starts in a discussion on GitHub.
              Read the threads here, then open the one you want to answer.
            </p>
          </div>
          <Button
            onClick={() =>
              openExternal(
                newDiscussionUrl({ category: "general", title: "" }),
              )
            }
          >
            <PlusIcon className="size-3.5" />
            Start a discussion
          </Button>
        </header>

        <section className="mt-10">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Pick what you want to give
          </h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {CONTRIBUTION_WAYS.map((way) => (
              <li key={way.key}>
                <button
                  type="button"
                  onClick={() => openExternal(wayDiscussionUrl(way))}
                  className="flex w-full items-start gap-2.5 rounded-md border bg-card p-3 text-left transition-colors hover:bg-muted/40 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]"
                >
                  <way.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="block text-sm font-medium">
                      {way.title}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {way.body}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-14 border-t pt-10">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-xl font-semibold">Open threads</h2>
            {categories.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                <CategoryChip
                  active={category === ALL}
                  onClick={() => setCategory(ALL)}
                  label="All"
                />
                {categories.map((c) => (
                  <CategoryChip
                    key={c.slug}
                    active={category === c.slug}
                    onClick={() => setCategory(c.slug)}
                    label={`${c.emoji} ${c.name}`.trim()}
                  />
                ))}
              </div>
            )}
          </div>

          {isLoading ? (
            <ul className="mt-5 space-y-2">
              {[0, 1, 2].map((i) => (
                <li key={i}>
                  <Skeleton className="h-16 w-full rounded-md" />
                </li>
              ))}
            </ul>
          ) : shown.length ? (
            <ul className="mt-5 space-y-2">
              {shown.map((d) => (
                <li key={d.number}>
                  <button
                    type="button"
                    onClick={() => openExternal(d.url)}
                    className="group flex w-full items-start gap-3 rounded-md border bg-card p-3 text-left transition-colors hover:bg-muted/40 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {d.title}
                        </span>
                        {d.isAnswered && (
                          <CircleCheckIcon className="size-3.5 shrink-0 text-emerald-500" />
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {`${d.category.emoji} ${d.category.name}`.trim()}
                        </span>
                        {d.author && <span>@{d.author.login}</span>}
                        <span>{relativeDay(d.createdAt)}</span>
                        <span className="inline-flex items-center gap-1">
                          <MessageSquareIcon className="size-3" />
                          {d.comments}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <ThumbsUpIcon className="size-3" />
                          {d.upvotes}
                        </span>
                      </div>
                    </div>
                    <ArrowUpRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-5">
              <EmptyState
                icon={MessagesSquareIcon}
                title="No threads yet"
                description="The board is empty. You can start the first thread."
              >
                <Button
                  variant="outline"
                  onClick={() => openExternal(DISCUSSIONS_URL)}
                >
                  Open GitHub Discussions
                  <ArrowUpRightIcon className="size-3.5" />
                </Button>
              </EmptyState>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function CategoryChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 py-1 text-xs transition-colors",
        "focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]",
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/50",
      )}
    >
      {label}
    </button>
  );
}
