import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../index";
import {
  browseCommunity,
  forkCommunityFlow,
  getCommunityAuthor,
  getCommunityFlow,
  listBookmarkedFlows,
  toggleBookmark,
} from "./flow-library";

/** Offset-based cursor: good enough until the community needs keyset paging. */
const cursorSchema = z.number().int().min(0).nullish();

// ============================================================================
// Router — browsing and profiles are public; bookmarking and forking into an
// account require a session. Publishing lives on the flow router (owner-only).
// The Community flow rules themselves live in the Flow library.
// ============================================================================

export const communityRouter = router({
  /**
   * Browse published flows. Anyone, signed in or not. Cursor-paginated.
   */
  list: publicProcedure
    .input(
      z.object({
        search: z.string().optional(),
        sort: z.enum(["popular", "recent"]).default("popular"),
        cursor: cursorSchema,
      })
    )
    .query(({ ctx, input }) => browseCommunity(input, ctx.session?.user.id)),

  /**
   * One published flow, full snapshot for the preview page.
   */
  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => getCommunityFlow(input.id, ctx.session?.user.id)),

  /**
   * Public author profile: the user and their published flows, paginated.
   */
  byAuthor: publicProcedure
    .input(z.object({ userId: z.string(), cursor: cursorSchema }))
    .query(({ ctx, input }) =>
      getCommunityAuthor(input.userId, input.cursor, ctx.session?.user.id)
    ),

  /**
   * The viewer's bookmarked community flows, most recently saved first.
   */
  bookmarks: protectedProcedure
    .input(z.object({ cursor: cursorSchema }))
    .query(({ ctx, input }) => listBookmarkedFlows(ctx.session.user.id, input.cursor)),

  /**
   * Bookmark or un-bookmark a published flow
   */
  toggleBookmark: protectedProcedure
    .input(z.object({ flowId: z.string() }))
    .mutation(({ ctx, input }) => toggleBookmark(input.flowId, ctx.session.user.id)),

  /**
   * Copy a published flow into the caller's own flows.
   * Signed-out users fork client-side into the local flow instead.
   */
  fork: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => forkCommunityFlow(input.id, ctx.session.user.id)),
});
