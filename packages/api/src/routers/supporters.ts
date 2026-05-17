import { env } from "@microflow/env/server";
import { polarClient } from "@microflow/auth/lib/payments";
import { protectedProcedure, publicProcedure, router } from "../index";

export type SupporterSource = "subscription" | "donation" | "github";

export type PublicSupporter = {
  name: string;
  since: string | null;
  source: SupporterSource;
};

let cache: { at: number; data: PublicSupporter[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

function firstName(fullName: string | null | undefined): string {
  const trimmed = fullName?.trim() ?? "";
  return trimmed.split(/\s+/)[0] || "Anonymous";
}

async function listSubscriptionSupporters(
  productId: string,
): Promise<PublicSupporter[]> {
  const out: PublicSupporter[] = [];
  const iter = await polarClient.subscriptions.list({
    productId,
    active: true,
    limit: 100,
  });
  for await (const page of iter) {
    for (const sub of page.result.items) {
      out.push({
        name: firstName(sub.customer?.name),
        since: sub.startedAt ? new Date(sub.startedAt).toISOString() : null,
        source: "subscription",
      });
    }
  }
  return out;
}

async function listDonationSupporters(
  productId: string,
): Promise<PublicSupporter[]> {
  // Dedupe by customerId so a repeat donor still gets one chip on the wall.
  const earliest = new Map<string, { name: string; at: Date }>();
  const iter = await polarClient.orders.list({
    productId,
    limit: 100,
  });
  for await (const page of iter) {
    for (const order of page.result.items) {
      if (!order.paid || order.status !== "paid") continue;
      const customerId = order.customerId ?? order.customer?.id;
      if (!customerId) continue;
      const name = firstName(order.customer?.name ?? order.billingName);
      const at = order.createdAt;
      const existing = earliest.get(customerId);
      if (!existing || at < existing.at) {
        earliest.set(customerId, { name, at });
      }
    }
  }
  return [...earliest.values()].map(({ name, at }) => ({
    name,
    since: at.toISOString(),
    source: "donation" as const,
  }));
}

type GithubSponsorNode = {
  createdAt: string | null;
  privacyLevel: "PUBLIC" | "PRIVATE";
  sponsorEntity: { login?: string | null; name?: string | null } | null;
};

async function listGithubSponsors(
  token: string,
  login: string,
): Promise<PublicSupporter[]> {
  // Single page is enough until the wall outgrows 100 sponsors.
  const query = `
    query SponsorsList($login: String!) {
      user(login: $login) {
        sponsorshipsAsMaintainer(
          first: 100
          activeOnly: true
          includePrivate: true
          orderBy: { field: CREATED_AT, direction: DESC }
        ) {
          nodes {
            createdAt
            privacyLevel
            sponsorEntity {
              ... on User { login name }
              ... on Organization { login name }
            }
          }
        }
      }
    }
  `;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "microflow-supporters",
    },
    body: JSON.stringify({ query, variables: { login } }),
  });
  if (!res.ok) {
    console.error("[supporters] github sponsors HTTP", res.status);
    return [];
  }
  const json = (await res.json()) as {
    data?: {
      user?: {
        sponsorshipsAsMaintainer?: { nodes?: GithubSponsorNode[] };
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    console.error("[supporters] github sponsors errors", json.errors);
    return [];
  }
  const nodes = json.data?.user?.sponsorshipsAsMaintainer?.nodes ?? [];
  return nodes.map((node) => {
    if (node.privacyLevel !== "PUBLIC") {
      return {
        name: "Anonymous",
        since: node.createdAt ?? null,
        source: "github" as const,
      };
    }
    const ent = node.sponsorEntity;
    const named = firstName(ent?.name);
    const display =
      named !== "Anonymous" ? named : (ent?.login ?? "Anonymous");
    return {
      name: display,
      since: node.createdAt ?? null,
      source: "github" as const,
    };
  });
}

export async function getPublicSupportersCached(): Promise<PublicSupporter[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const subscriptionProductId = env.POLAR_SUPPORTER_PRODUCT_ID;
  const donationProductId = env.POLAR_DONATION_PRODUCT_ID;
  const githubToken = env.GITHUB_SPONSORS_TOKEN;
  const githubLogin = env.GITHUB_SPONSORS_LOGIN;

  const [subs, donations, github] = await Promise.all([
    subscriptionProductId
      ? listSubscriptionSupporters(subscriptionProductId).catch((err) => {
          console.error("[supporters] subscription list failed", err);
          return [] as PublicSupporter[];
        })
      : Promise.resolve([] as PublicSupporter[]),
    donationProductId
      ? listDonationSupporters(donationProductId).catch((err) => {
          console.error("[supporters] donation list failed", err);
          return [] as PublicSupporter[];
        })
      : Promise.resolve([] as PublicSupporter[]),
    githubToken
      ? listGithubSponsors(githubToken, githubLogin).catch((err) => {
          console.error("[supporters] github sponsors failed", err);
          return [] as PublicSupporter[];
        })
      : Promise.resolve([] as PublicSupporter[]),
  ]);

  // Newest first overall — wall reads as a fresh stream of love.
  const merged = [...subs, ...donations, ...github].sort((a, b) => {
    const at = a.since ? Date.parse(a.since) : 0;
    const bt = b.since ? Date.parse(b.since) : 0;
    return bt - at;
  });

  cache = { at: Date.now(), data: merged };
  return cache.data;
}

export const supportersRouter = router({
  /**
   * Whether the current user has an active Supporter subscription.
   */
  myStatus: protectedProcedure.query(async ({ ctx }) => {
    const supporterProductId = env.POLAR_SUPPORTER_PRODUCT_ID;
    if (!supporterProductId) {
      return { isSupporter: false, since: null as string | null };
    }

    try {
      const state = await polarClient.customers.getStateExternal({
        externalId: ctx.session.user.id,
      });

      const active = state.activeSubscriptions?.find(
        (sub) => sub.productId === supporterProductId,
      );

      return {
        isSupporter: Boolean(active),
        since: active?.startedAt
          ? new Date(active.startedAt).toISOString()
          : null,
      };
    } catch {
      return { isSupporter: false, since: null as string | null };
    }
  }),

  /**
   * Public anonymized list of supporters (subscription + one-time + GitHub).
   */
  publicList: publicProcedure.query(async () => {
    return { supporters: await getPublicSupportersCached() };
  }),
});
