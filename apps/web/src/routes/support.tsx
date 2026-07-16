import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Github, Heart, LogIn, Sparkles } from "lucide-react";

import { authClient } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const Route = createFileRoute("/support")({
  component: SupportPage,
});

const GITHUB_SPONSORS_URL = "https://github.com/sponsors/xiduzo";

type SupporterSource = "subscription" | "donation" | "github";

const sourceMeta: Record<
  SupporterSource,
  { Icon: typeof Heart; label: string; iconTint: string; chipTint: string }
> = {
  subscription: {
    Icon: Heart,
    label: "Recurring",
    iconTint: "fill-rose-500 text-rose-500",
    chipTint: "border-rose-500/30 bg-rose-500/[0.04] hover:bg-rose-500/[0.08]",
  },
  donation: {
    Icon: Sparkles,
    label: "One-time",
    iconTint: "text-amber-500",
    chipTint:
      "border-amber-500/30 bg-amber-500/[0.04] hover:bg-amber-500/[0.08]",
  },
  github: {
    Icon: Github,
    label: "GitHub Sponsor",
    iconTint: "text-foreground",
    chipTint:
      "border-foreground/25 bg-foreground/[0.04] hover:bg-foreground/[0.08]",
  },
};

async function startCheckout(slug: "supporter" | "donation") {
  await authClient.checkout({ slug });
}

function SupportPage() {
  const { data: session } = authClient.useSession();
  const isSignedIn = !!session?.user;

  const { data: supportersData } = useQuery({
    ...trpc.supporters.publicList.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });
  const supporters = supportersData?.supporters ?? [];
  const recurringCount = supporters.filter(
    (s) => s.source === "subscription",
  ).length;
  const oneTimeCount = supporters.filter((s) => s.source === "donation").length;
  const githubCount = supporters.filter((s) => s.source === "github").length;
  const total = supporters.length;

  return (
    <div className="h-full w-full overflow-y-auto">
      <main className="mx-auto flex h-full w-full max-w-5xl flex-col gap-12 px-4 py-12">
        <header className="text-center">
          <h1 className="mb-4 text-4xl font-bold tracking-tight">
            Support Microflow
          </h1>
          <p className="mx-auto max-w-3xl text-muted-foreground">
            Microflow is, and <strong className="underline">always</strong> will
            be, fully open-source.
            <br />
            If it saved you a weekend, helped a student, or powered an
            installation — toss something in the jar so it keeps growing.
          </p>
        </header>

        <section className="grid items-stretch gap-4 md:grid-cols-3">
          <Card className="flex flex-col">
            <CardHeader className="flex-1">
              <div className="mb-2 flex items-start justify-between">
                <Github className="size-6 text-foreground" />
                <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  01
                </span>
              </div>
              <CardTitle>GitHub Sponsors</CardTitle>
              <CardDescription>
                One-time or recurring support via GitHub. Most visible — your
                avatar shows up on the repo.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <a
                href={GITHUB_SPONSORS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full"
              >
                <Button className="w-full">
                  Sponsor on GitHub
                  <ArrowRight className="size-3.5" />
                </Button>
              </a>
            </CardContent>
          </Card>

          <Card className="flex flex-col">
            <CardHeader className="flex-1">
              <div className="mb-2 flex items-start justify-between">
                <Heart className="size-6 fill-rose-500 text-rose-500" />
                <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  02
                </span>
              </div>
              <CardTitle>Monthly Supporter</CardTitle>
              <CardDescription>
                Recurring tip jar — you pick the amount at checkout. No paid
                features unlocked, just a Supporter badge in the app and your
                name in credits.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SupportButton
                isSignedIn={isSignedIn}
                onClick={() => startCheckout("supporter")}
                label="Become a Supporter"
              />
            </CardContent>
          </Card>

          <Card className="flex flex-col">
            <CardHeader className="flex-1">
              <div className="mb-2 flex items-start justify-between">
                <Sparkles className="size-6 text-amber-500" />
                <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  03
                </span>
              </div>
              <CardTitle>One-time donation</CardTitle>
              <CardDescription>
                Throw a coin in the jar. Same cosmetic Supporter mention, no
                recurring charge.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SupportButton
                isSignedIn={isSignedIn}
                onClick={() => startCheckout("donation")}
                label="Send a one-time tip"
              />
            </CardContent>
          </Card>
        </section>

        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">
            No budget? Leaving a review is a free way to help Microflow grow.
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

        <section className="border-t pt-12 grow">
          {total > 0 ? (
            <>
              <div className="mb-8 flex flex-col items-center text-center">
                <div className="mb-4 inline-flex items-center gap-2 border bg-card px-3 py-1 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  <span className="size-1.5 bg-rose-500" />
                  Wall of Supporters
                </div>
                <h2 className="mb-2 text-2xl font-bold sm:text-3xl">
                  {total} {total === 1 ? "person keeps" : "people keep"}{" "}
                  Microflow growing
                </h2>
                <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
                  {recurringCount > 0 && (
                    <span className="inline-flex items-center gap-1.5">
                      <Heart className="size-3 fill-rose-500 text-rose-500" />
                      {recurringCount} recurring
                    </span>
                  )}
                  {oneTimeCount > 0 && (
                    <span className="inline-flex items-center gap-1.5">
                      <Sparkles className="size-3 text-amber-500" />
                      {oneTimeCount} one-time
                    </span>
                  )}
                  {githubCount > 0 && (
                    <a
                      href={GITHUB_SPONSORS_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 underline-offset-2 hover:text-foreground hover:underline"
                    >
                      <Github className="size-3" />
                      {githubCount} from GitHub
                    </a>
                  )}
                </div>
              </div>

              <ul className="flex flex-wrap justify-center gap-2">
                {supporters.map((supporter, i) => {
                  const meta = sourceMeta[supporter.source];
                  const Icon = meta.Icon;
                  return (
                    <li
                      key={`${supporter.source}-${supporter.name}-${i}`}
                      title={`${meta.label}${supporter.since ? ` · since ${new Date(supporter.since).toLocaleDateString()}` : ""}`}
                      className={`inline-flex items-center gap-1.5 border px-3 py-1.5 text-sm transition-colors ${meta.chipTint}`}
                    >
                      <Icon className={`size-3 ${meta.iconTint}`} />
                      {supporter.name}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <div className="mx-auto max-w-md text-center">
              <Heart className="mx-auto mb-4 size-8 fill-rose-500 text-rose-500" />
              <h2 className="mb-2 text-xl font-bold">No supporters yet</h2>
              <p className="mb-6 text-sm text-muted-foreground">
                Be the first to keep Microflow growing. Your first name will
                land here.
              </p>
              {isSignedIn ? (
                <Button onClick={() => startCheckout("supporter")}>
                  Be the first Supporter
                  <ArrowRight className="size-3.5" />
                </Button>
              ) : (
                <Button render={(props) => <Link to="/login" {...props} />}>
                  <LogIn className="size-3.5" />
                  Sign in to support
                </Button>
              )}
            </div>
          )}
        </section>

        <p className="text-center text-xs max-w-lg mx-auto text-muted-foreground">
          Supporting doesn&apos;t unlock features. The whole app stays free for
          everyone — that&apos;s the point. You&apos;re funding maintenance, new
          components, and the hosted services that some of the community uses.
        </p>
      </main>
    </div>
  );
}

function SupportButton({
  isSignedIn,
  onClick,
  label,
}: {
  isSignedIn: boolean;
  onClick: () => void;
  label: string;
}) {
  if (!isSignedIn) {
    return (
      <div className="flex flex-col gap-2">
        <Button className="w-full" disabled>
          {label}
          <ArrowRight className="size-3.5" />
        </Button>
        <Link
          to="/login"
          className="inline-flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <LogIn className="size-3" />
          Sign in to support
        </Link>
      </div>
    );
  }
  return (
    <Button className="w-full" onClick={onClick}>
      {label}
      <ArrowRight className="size-3.5" />
    </Button>
  );
}
