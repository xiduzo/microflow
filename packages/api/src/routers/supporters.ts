import { env } from "@microflow/env/server";
import { polarClient } from "@microflow/auth/lib/payments";
import { protectedProcedure, publicProcedure, router } from "../index";

export type PublicSupporter = { name: string; since: string | null };

let cache: { at: number; data: PublicSupporter[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getPublicSupportersCached(): Promise<PublicSupporter[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const productId = env.POLAR_SUPPORTER_PRODUCT_ID;
  if (!productId) {
    cache = { at: Date.now(), data: [] };
    return cache.data;
  }

  const supporters: PublicSupporter[] = [];
  try {
    const iter = await polarClient.subscriptions.list({
      productId,
      active: true,
      limit: 100,
    });
    for await (const page of iter) {
      for (const sub of page.result.items) {
        const fullName = sub.customer?.name?.trim() ?? "";
        const firstName = fullName.split(/\s+/)[0] || "Anonymous";
        supporters.push({
          name: firstName,
          since: sub.startedAt ? new Date(sub.startedAt).toISOString() : null,
        });
      }
    }
  } catch (err) {
    console.error("[supporters] list failed", err);
  }

  cache = { at: Date.now(), data: supporters };
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
   * Public anonymized list of active supporters (first name + start date).
   */
  publicList: publicProcedure.query(async () => {
    return { supporters: await getPublicSupportersCached() };
  }),
});
