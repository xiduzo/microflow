import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Github, Heart, Sparkles } from "lucide-react";
import { toast } from "sonner";

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

function SupportPage() {
  const { data: supportersData } = useQuery({
    ...trpc.supporters.publicList.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });
  const supporters = supportersData?.supporters ?? [];

  const startCheckout = async (slug: "supporter" | "donation") => {
    try {
      await authClient.checkout({ slug });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start checkout",
      );
    }
  };

  return (
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

      <section className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
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
              className="inline-flex w-full items-center justify-center gap-2"
            >
              <Button className="w-full">
                Sponsor on GitHub
                <ArrowRight className="size-3.5" />
              </Button>
            </a>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Heart className="mb-2 size-6 text-rose-500" />
            <CardTitle>Supporter — €3 / month</CardTitle>
            <CardDescription>
              Recurring tip jar. No paid features unlocked — just a Supporter badge in the app and your name in credits.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className="w-full"
              onClick={() => startCheckout("supporter")}
            >
              Become a Supporter
              <ArrowRight className="size-3.5" />
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Sparkles className="mb-2 size-6 text-primary" />
            <CardTitle>One-time donation</CardTitle>
            <CardDescription>
              Throw a coin in the jar. Same cosmetic Supporter mention, no recurring charge.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className="w-full"
              onClick={() => startCheckout("donation")}
            >
              Send a one-time tip
              <ArrowRight className="size-3.5" />
            </Button>
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
            <Button onClick={() => startCheckout("supporter")}>
              Be the first Supporter
              <ArrowRight className="size-3.5" />
            </Button>
          </div>
        )}
      </section>

      <p className="text-center text-sm text-muted-foreground">
        Supporting doesn&apos;t unlock features. The whole app stays free for everyone — that&apos;s the point. You&apos;re funding maintenance, new components, and the hosted services that some of the community uses.
      </p>
    </main>
  );
}
