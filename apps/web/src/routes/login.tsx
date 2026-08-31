import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  CloudIcon,
  GlobeIcon,
  LaptopIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

import { SignInForm } from "@/components/sign-in-form";
import { getSession } from "@/lib/auth-client";

export const Route = createFileRoute("/login")({
  // Routes that bounce a signed-out visitor here append `?redirect=`, so the
  // sign-in can return them to the page they asked for.
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  beforeLoad: async () => {
    const session = await getSession();
    if (session.data) {
      throw redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

type Perk = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const PERKS: Perk[] = [
  {
    icon: CloudIcon,
    title: "Unlimited flows",
    body: "Make as many flows as you want. Microflow keeps them in the cloud, not in this browser.",
  },
  {
    icon: LaptopIcon,
    title: "Your flows on each device",
    body: "Open a flow on a different computer, or in the Microflow Studio desktop app.",
  },
  {
    icon: UsersIcon,
    title: "Live collaboration",
    body: "Share a flow with other people. Each cursor moves on the canvas in real time.",
  },
  {
    icon: GlobeIcon,
    title: "Publish and fork",
    body: "Publish a flow to the Community. Bookmark the flows you like, and fork them as a start point.",
  },
];

function RouteComponent() {
  const { redirect: redirectTo } = Route.useSearch();

  return (
    <div className="h-full overflow-y-auto">
      <div className="grid min-h-full w-full lg:grid-cols-[1.15fr_minmax(26rem,0.85fr)]">
        <aside className="bg-primary text-primary-foreground flex flex-col justify-center gap-10 px-8 py-12 lg:px-16 lg:py-16">
          <div className="flex max-w-2xl flex-col gap-3">
            <p className="text-[11px] uppercase tracking-widest opacity-70">
              Microflow account
            </p>
            <h2 className="text-2xl font-bold leading-tight lg:text-3xl">
              You use one local flow.
            </h2>
            <p className="max-w-lg text-xs/relaxed opacity-80">
              This flow stays in this browser only. If you clear the site data,
              the flow is gone. An account removes this limit. The account is
              free and it has no password.
            </p>
          </div>

          <ul className="grid max-w-3xl gap-x-10 gap-y-7 sm:grid-cols-2">
            {PERKS.map((perk) => (
              <li key={perk.title} className="flex gap-3">
                <perk.icon className="mt-0.5 size-4 shrink-0 opacity-90" />
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold">{perk.title}</span>
                  <span className="text-[11px]/relaxed opacity-75">
                    {perk.body}
                  </span>
                </div>
              </li>
            ))}
          </ul>

          <p className="max-w-lg text-[11px] opacity-70">
            Your local flow moves to your account. You lose no work when you
            sign in.
          </p>
        </aside>

        <div className="bg-card flex items-center justify-center px-8 py-12 lg:px-14">
          <SignInForm
            bare
            redirectTo={redirectTo}
            className="w-full max-w-sm"
            title="Sign in or make an account"
            description="Use one email address for both. Microflow sends a sign-in code to your email. If you are new, this code makes your account."
          />
        </div>
      </div>
    </div>
  );
}
