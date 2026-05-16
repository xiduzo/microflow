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

  return (
    <div className="h-full w-full overflow-y-auto">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-12 px-4 py-12">
        <header className="text-center">
          <div className="mb-6 inline-flex items-center gap-2 border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium tracking-wide text-primary">
            <span className="size-1.5 bg-primary" />
            Keep Microflow open-source
          </div>
          <h1 className="mb-4 text-4xl font-bold tracking-tight">
            Support Microflow
          </h1>
          <p className="mx-auto max-w-xl text-muted-foreground">
            Microflow is, and always will be, fully open-source. If it saved you a weekend, helped a student, or powered an installation — toss something in the jar so it keeps growing.
          </p>
        </header>

        <section className="grid gap-4 md:grid-cols-3 items-stretch">
          <Card className="flex flex-col">
            <CardHeader className="flex-1">
              <Github className="mb-2 size-6 text-primary" />
              <CardTitle>GitHub Sponsors</CardTitle>
              <CardDescription>
                One-time or recurring support via GitHub. Most visible — your avatar shows up on the repo.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <a
                href="https://github.com/sponsors/xiduzo"
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
              <Heart className="mb-2 size-6 text-rose-500" />
              <CardTitle>Supporter — €3 / month</CardTitle>
              <CardDescription>
                Recurring tip jar. No paid features unlocked — just a Supporter badge in the app and your name in credits.
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
              <Sparkles className="mb-2 size-6 text-primary" />
              <CardTitle>One-time donation</CardTitle>
              <CardDescription>
                Throw a coin in the jar. Same cosmetic Supporter mention, no recurring charge.
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

        <section className="border-t pt-12">
          {supporters.length > 0 ? (
            <>
              <div className="mb-8 text-center">
                <h2 className="mb-2 text-2xl font-bold">Wall of Supporters</h2>
                <p className="text-sm text-muted-foreground">
                  {supporters.length}{" "}
                  {supporters.length === 1 ? "person keeps" : "people keep"} Microflow growing. Thank you.
                </p>
              </div>
              <ul className="flex flex-wrap justify-center gap-2">
                {supporters.map((supporter, i) => (
                  <li
                    key={`${supporter.name}-${i}`}
                    className="inline-flex items-center gap-1.5 border bg-card px-3 py-1.5 text-sm"
                  >
                    <Heart className="size-3 fill-rose-500 text-rose-500" />
                    {supporter.name}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="mx-auto max-w-md text-center">
              <Heart className="mx-auto mb-4 size-8 text-rose-500" />
              <h2 className="mb-2 text-xl font-bold">No supporters yet</h2>
              <p className="mb-6 text-sm text-muted-foreground">
                Be the first to keep Microflow growing. Your first name will land here.
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

        <p className="text-center text-sm text-muted-foreground">
          Supporting doesn&apos;t unlock features. The whole app stays free for everyone — that&apos;s the point. You&apos;re funding maintenance, new components, and the hosted services that some of the community uses.
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
