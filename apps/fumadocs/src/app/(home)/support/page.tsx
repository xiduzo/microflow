import Link from "next/link";
import { Github, Heart, Sparkles, ArrowRight } from "lucide-react";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

const tiers = [
  {
    icon: Github,
    title: "GitHub Sponsors",
    blurb:
      "One-time or recurring support via GitHub. Most visible — your avatar shows up on the repo.",
    cta: "Sponsor on GitHub",
    href: "https://github.com/sponsors/xiduzo",
    external: true,
  },
  {
    icon: Heart,
    title: "Supporter — €3 / month",
    blurb:
      "Recurring tip jar. No paid features unlocked — just a Supporter badge in the app and your name in credits.",
    cta: "Become a Supporter",
    href: `${SERVER_URL}/api/auth/checkout/supporter`,
    external: false,
  },
  {
    icon: Sparkles,
    title: "One-time donation",
    blurb: "Throw a coin in the jar. Same cosmetic Supporter mention, no recurring charge.",
    cta: "Send a one-time tip",
    href: `${SERVER_URL}/api/auth/checkout/donation`,
    external: false,
  },
];

export default function SupportPage() {
  return (
    <main className="flex flex-col">
      <section className="px-4 py-20 text-center md:py-28">
        <div className="mx-auto max-w-2xl">
          <div className="mb-6 inline-flex items-center gap-2 border border-fd-primary/30 bg-fd-primary/5 px-3 py-1 text-xs font-medium tracking-wide text-fd-primary">
            <span className="size-1.5 bg-fd-primary" />
            Keep Microflow open-source
          </div>
          <h1 className="mb-4 text-4xl font-bold tracking-tight text-fd-foreground sm:text-5xl">
            Support Microflow
          </h1>
          <p className="text-fd-muted-foreground">
            Microflow is, and always will be, fully open-source. If it saved you a weekend, helped a student, or powered an installation — toss something in the jar so it keeps growing.
          </p>
        </div>
      </section>

      <section className="px-4 pb-20">
        <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-3">
          {tiers.map((tier) => (
            <article
              key={tier.title}
              className="flex flex-col border border-fd-border bg-fd-card p-6 transition-colors hover:border-fd-primary/40"
            >
              <tier.icon className="mb-4 size-6 text-fd-primary" />
              <h2 className="mb-2 text-lg font-semibold text-fd-foreground">{tier.title}</h2>
              <p className="mb-6 flex-1 text-sm text-fd-muted-foreground">{tier.blurb}</p>
              {tier.external ? (
                <a
                  href={tier.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 border border-fd-primary bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
                >
                  {tier.cta}
                  <ArrowRight className="size-3.5" />
                </a>
              ) : (
                <Link
                  href={tier.href}
                  className="inline-flex items-center justify-center gap-2 border border-fd-primary bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
                >
                  {tier.cta}
                  <ArrowRight className="size-3.5" />
                </Link>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="border-t border-fd-border px-4 py-12 text-center text-sm text-fd-muted-foreground">
        <p className="mx-auto max-w-xl">
          Supporting doesn&apos;t unlock features. The whole app stays free for everyone — that&apos;s the point. You&apos;re funding maintenance, new components, and the hosted services that some of the community uses.
        </p>
      </section>
    </main>
  );
}
