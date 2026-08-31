import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRightIcon,
  BookOpenIcon,
  Github,
  Heart,
  LogIn,
  MessagesSquareIcon,
  Sparkles,
} from "lucide-react";

import { authClient } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { CONTRIBUTION_WAYS, wayDiscussionUrl } from "@/lib/contribute";
import { openDocs, openExternal } from "@/lib/docs";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/support")({
  component: SupportPage,
});

const GITHUB_SPONSORS_URL = "https://github.com/sponsors/xiduzo";

type SupporterSource = "subscription" | "donation" | "github";

const SOURCE_META: Record<
  SupporterSource,
  { Icon: typeof Heart; label: string; group: string; tint: string }
> = {
  subscription: {
    Icon: Heart,
    label: "Recurring",
    group: "Monthly supporters",
    tint: "fill-rose-500 text-rose-500",
  },
  donation: {
    Icon: Sparkles,
    label: "One-time",
    group: "One-time tips",
    tint: "text-amber-500",
  },
  github: {
    Icon: Github,
    label: "GitHub Sponsor",
    group: "GitHub sponsors",
    tint: "text-foreground",
  },
};

const GROUP_ORDER: SupporterSource[] = ["subscription", "donation", "github"];

type Ask = {
  key: "supporter" | "donation" | "github";
  title: string;
  body: string;
  cta: string;
};

const ASKS: Ask[] = [
  {
    key: "supporter",
    title: "Monthly supporter",
    body: "Choose your amount. Microflow charges it every month. You can cancel at any time.",
    cta: "Become a supporter",
  },
  {
    key: "donation",
    title: "One-time tip",
    body: "Give once, at any amount. The payment happens one time only, so you never need to cancel it.",
    cta: "Send a one-time tip",
  },
  {
    key: "github",
    title: "GitHub Sponsors",
    body: "Sponsor Microflow through GitHub, every month or one time. Your avatar also appears on the Microflow repository.",
    cta: "Sponsor on GitHub",
  },
];

async function startCheckout(slug: "supporter" | "donation") {
  await authClient.checkout({ slug });
}

function SupportPage() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const isSignedIn = !!session?.user;

  const { data: supportersData } = useQuery({
    ...trpc.supporters.publicList.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });
  const supporters = supportersData?.supporters ?? [];
  const total = supporters.length;
  const counts = {
    recurring: supporters.filter((s) => s.source === "subscription").length,
    oneTime: supporters.filter((s) => s.source === "donation").length,
    github: supporters.filter((s) => s.source === "github").length,
  };

  return (
    <div className="h-full w-full overflow-y-auto">
      <main className="mx-auto w-full max-w-3xl px-4 py-16">
        <header>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            {total > 0 ? (
              <>
                {total} {total === 1 ? "person keeps" : "people keep"} Microflow
                going
              </>
            ) : (
              <>Microflow has no supporters yet</>
            )}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
            {counts.recurring > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <Heart className="size-3 fill-rose-500 text-rose-500" />
                {counts.recurring} recurring
              </span>
            )}
            {counts.oneTime > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <Sparkles className="size-3 text-amber-500" />
                {counts.oneTime} one-time
              </span>
            )}
            {counts.github > 0 && (
              <a
                href={GITHUB_SPONSORS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 underline-offset-2 hover:text-foreground hover:underline"
              >
                <Github className="size-3" />
                {counts.github} from GitHub
              </a>
            )}
          </div>
        </header>

        {total > 0 ? (
          <div className="mt-8 space-y-6">
            {GROUP_ORDER.map((source) => {
              const group = supporters.filter((s) => s.source === source);
              if (!group.length) return null;
              const meta = SOURCE_META[source];
              return (
                <section key={source}>
                  <h2 className="mb-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {meta.group}
                  </h2>
                  <ul className="flex flex-wrap gap-1.5">
                    {group.map((supporter, index) => (
                      <li
                        key={`${source}-${supporter.name}-${index}`}
                        title={
                          supporter.since
                            ? `${meta.label} · since ${new Date(supporter.since).toLocaleDateString()}`
                            : meta.label
                        }
                        className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-sm"
                      >
                        <meta.Icon className={cn("size-3", meta.tint)} />
                        {supporter.name}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : (
          <p className="mt-6 text-muted-foreground">
            The wall is empty. You can be the first name on it.
          </p>
        )}

        <section className="mt-14 border-t pt-10">
          <h2 className="text-xl font-semibold">
            {total > 0 ? "Join them" : "Be the first"}
          </h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Microflow is open-source and stays open-source. Support gives you
            no extra features. It pays for maintenance, new components and the
            hosted services that the community uses. Every supporter gets a
            Supporter badge in the app and a name on this page.
          </p>

          <ul className="mt-6 divide-y border-y">
            {ASKS.map((ask, index) => (
              <li
                key={ask.key}
                className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:gap-6"
              >
                <div className="flex-1">
                  <h3 className="font-semibold">{ask.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {ask.body}
                  </p>
                </div>
                <AskAction
                  ask={ask}
                  isSignedIn={isSignedIn}
                  emphasis={index === 0 ? "default" : "outline"}
                />
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-14 border-t pt-10">
          <h2 className="text-xl font-semibold">No money? Give time.</h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Money is one way to help, and it is not the most important one.
            Design, code review, promotion, documentation, translations,
            walkthroughs and hardware reports all make Microflow better. Each
            one of them starts in a discussion on GitHub.
          </p>

          <ul className="mt-6 flex flex-wrap gap-1.5">
            {CONTRIBUTION_WAYS.map((way) => (
              <li key={way.key}>
                <button
                  type="button"
                  title={way.body}
                  onClick={() => openExternal(wayDiscussionUrl(way))}
                  className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-sm transition-colors hover:bg-muted/40 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]"
                >
                  <way.icon className="size-3 text-muted-foreground" />
                  {way.title}
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-6 flex flex-wrap gap-2">
            <Button onClick={() => navigate({ to: "/discussions" })}>
              <MessagesSquareIcon className="size-3.5" />
              Browse discussions
            </Button>
            <Button
              variant="outline"
              onClick={() => openDocs("/docs/contributing/ways-to-help")}
            >
              <BookOpenIcon className="size-3.5" />
              Read how to help
              <ArrowUpRightIcon className="size-3.5" />
            </Button>
          </div>
        </section>

        <div className="mt-12 flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">
            No budget? A review is free and helps as much.
          </p>
          <a
            href="https://www.producthunt.com/products/microflow/reviews/new?utm_source=badge-product_review&utm_medium=badge&utm_source=badge-microflow"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              src="https://api.producthunt.com/widgets/embed-image/v1/product_review.svg?product_id=1268428&theme=light"
              alt="Microflow - Microcontrollers made simple. | Product Hunt"
              width={250}
              height={54}
              className="dark:hidden"
            />
            <img
              src="https://api.producthunt.com/widgets/embed-image/v1/product_review.svg?product_id=1268428&theme=dark"
              alt="Microflow - Microcontrollers made simple. | Product Hunt"
              width={250}
              height={54}
              className="hidden dark:block"
            />
          </a>
        </div>
      </main>
    </div>
  );
}

function AskAction({
  ask,
  isSignedIn,
  emphasis,
}: {
  ask: Ask;
  isSignedIn: boolean;
  emphasis: "default" | "outline";
}) {
  // Destructured so the narrowing below survives into the onClick closure.
  const { key } = ask;

  if (key === "github") {
    return (
      <a
        href={GITHUB_SPONSORS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0"
      >
        <Button variant={emphasis} className="w-full sm:w-auto">
          <Github className="size-3.5" />
          {ask.cta}
        </Button>
      </a>
    );
  }

  if (!isSignedIn) {
    return (
      <Button
        variant={emphasis}
        className="w-full shrink-0 sm:w-auto"
        render={(props) => <Link to="/login" {...props} />}
      >
        <LogIn className="size-3.5" />
        Sign in to support
      </Button>
    );
  }

  return (
    <Button
      variant={emphasis}
      className="w-full shrink-0 sm:w-auto"
      onClick={() => startCheckout(key)}
    >
      {ask.cta}
      <ArrowRight className="size-3.5" />
    </Button>
  );
}
