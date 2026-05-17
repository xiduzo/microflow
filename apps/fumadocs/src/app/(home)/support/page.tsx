import { ArrowRight, Github, Heart, Sparkles } from "lucide-react";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";
const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL ?? "";
const GITHUB_SPONSORS_URL = "https://github.com/sponsors/xiduzo";

type SupporterSource = "subscription" | "donation" | "github";
type Supporter = {
  name: string;
  since: string | null;
  source: SupporterSource;
};

async function getSupporters(): Promise<Supporter[]> {
  if (!SERVER_URL) return [];
  try {
    const res = await fetch(`${SERVER_URL}/api/public/supporters`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { supporters?: Supporter[] };
    return data.supporters ?? [];
  } catch {
    return [];
  }
}

const tiers = [
  {
    index: "01",
    icon: Github,
    title: "GitHub Sponsors",
    blurb:
      "One-time or recurring support via GitHub. Most visible — your avatar shows up on the repo.",
    cta: "Sponsor on GitHub",
    href: GITHUB_SPONSORS_URL,
    accent: "text-fd-foreground",
  },
  {
    index: "02",
    icon: Heart,
    title: "Monthly Supporter",
    blurb:
      "Recurring tip jar — you pick the amount at checkout. No paid features unlocked, just a Supporter badge in the app and your name in credits.",
    cta: "Become a Supporter",
    href: `${WEB_URL}/support`,
    accent: "text-rose-500",
  },
  {
    index: "03",
    icon: Sparkles,
    title: "One-time donation",
    blurb:
      "Throw a coin in the jar. Same cosmetic Supporter mention, no recurring charge.",
    cta: "Send a one-time tip",
    href: `${WEB_URL}/support`,
    accent: "text-amber-500",
  },
] as const;

const sourceMeta: Record<
  SupporterSource,
  { Icon: typeof Heart; label: string; iconTint: string; chipTint: string }
> = {
  subscription: {
    Icon: Heart,
    label: "Recurring",
    iconTint: "fill-rose-500 text-rose-500",
    chipTint: "border-rose-500/30 bg-rose-500/[0.04] hover:bg-rose-500/[0.07]",
  },
  donation: {
    Icon: Sparkles,
    label: "One-time",
    iconTint: "text-amber-500",
    chipTint:
      "border-amber-500/30 bg-amber-500/[0.04] hover:bg-amber-500/[0.07]",
  },
  github: {
    Icon: Github,
    label: "GitHub Sponsor",
    iconTint: "text-fd-foreground",
    chipTint:
      "border-fd-foreground/25 bg-fd-foreground/[0.04] hover:bg-fd-foreground/[0.08]",
  },
};

export default async function SupportPage() {
  const supporters = await getSupporters();
  const recurringCount = supporters.filter(
    (s) => s.source === "subscription",
  ).length;
  const oneTimeCount = supporters.filter((s) => s.source === "donation").length;
  const githubCount = supporters.filter((s) => s.source === "github").length;
  const total = supporters.length;

  return (
    <main className="flex flex-col">
      {/* HEADER */}
      <section className="relative px-4 pt-20 pb-16 md:pt-28 md:pb-20">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="mb-5 text-4xl font-bold tracking-tight text-fd-foreground sm:text-6xl">
            Support Microflow
          </h1>
          <p className="text-fd-muted-foreground sm:text-lg">
            Microflow is, and <strong className="underline">always</strong> will
            be, fully open-source.
            <br />
            If it saved you a weekend, helped a student, or powered an
            installation — toss something in the jar so it keeps growing.
          </p>
        </div>
      </section>

      {/* TIER CARDS */}
      <section className="px-4 pb-20">
        <div className="mx-auto grid max-w-5xl gap-px bg-fd-border md:grid-cols-3 md:border md:border-fd-border">
          {tiers.map((tier) => (
            <article
              key={tier.title}
              className="group relative flex flex-col bg-fd-card p-6 transition-colors hover:bg-fd-card/60 md:p-8"
            >
              <div className="mb-6 flex items-start justify-between">
                <tier.icon className={`size-7 ${tier.accent}`} />
                <span className="font-mono text-xs uppercase tracking-[0.18em] text-fd-muted-foreground">
                  {tier.index}
                </span>
              </div>
              <h2 className="mb-2 text-lg font-semibold text-fd-foreground">
                {tier.title}
              </h2>
              <p className="mb-8 flex-1 text-sm leading-relaxed text-fd-muted-foreground">
                {tier.blurb}
              </p>
              <a
                href={tier.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-between gap-2 border-t border-fd-border pt-4 text-sm font-medium text-fd-foreground transition-colors hover:text-fd-primary"
              >
                {tier.cta}
                <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </a>
            </article>
          ))}
        </div>
      </section>

      {/* WALL */}
      <section className="border-t border-fd-border px-4 py-20">
        <div className="mx-auto max-w-5xl">
          {total > 0 ? (
            <>
              <div className="mb-10 flex flex-col items-center text-center">
                <div className="mb-4 inline-flex items-center gap-2 border border-fd-border bg-fd-card px-3 py-1 text-xs font-mono uppercase tracking-[0.18em] text-fd-muted-foreground">
                  <span className="size-1.5 bg-rose-500" />
                  Wall of Supporters
                </div>
                <h2 className="mb-3 text-3xl font-bold text-fd-foreground sm:text-4xl">
                  {total} {total === 1 ? "person keeps" : "people keep"}{" "}
                  Microflow growing
                </h2>
                <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-sm text-fd-muted-foreground">
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
                      className="inline-flex items-center gap-1.5 underline-offset-2 hover:text-fd-foreground hover:underline"
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
                      className={`inline-flex items-center gap-1.5 border px-3 py-1.5 text-sm text-fd-foreground transition-colors ${meta.chipTint}`}
                    >
                      <Icon className={`size-3 ${meta.iconTint}`} />
                      {supporter.name}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <div className="mx-auto max-w-md border border-fd-border bg-fd-card p-10 text-center">
              <Heart className="mx-auto mb-4 size-8 fill-rose-500 text-rose-500" />
              <h2 className="mb-2 text-2xl font-bold text-fd-foreground">
                No supporters yet
              </h2>
              <p className="mb-6 text-sm text-fd-muted-foreground">
                Be the first to keep Microflow growing. Your first name will
                land here.
              </p>
              <a
                href={`${WEB_URL}/support`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 border border-fd-primary bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
              >
                Be the first Supporter
                <ArrowRight className="size-3.5" />
              </a>
            </div>
          )}
        </div>
      </section>

      <section className="border-t border-fd-border px-4 py-12 text-center text-xs text-fd-muted-foreground">
        <p className="mx-auto max-w-xl">
          Supporting doesn&apos;t unlock features. The whole app stays free for
          everyone — that&apos;s the point. You&apos;re funding maintenance, new
          components, and the hosted services that some of the community uses.
        </p>
      </section>
    </main>
  );
}
