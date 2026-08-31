import { z } from "zod";
import { and, desc, eq, ilike, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { db } from "@microflow/db";
import { flow, flowBookmark } from "@microflow/db/schema/flow";
import { user } from "@microflow/db/schema/auth";
import { userSettings } from "@microflow/db/schema/user-settings";
import { FlowDocument } from "@microflow/collab/server";
import { protectedProcedure, publicProcedure, router } from "../index";
import { decodeFlowData, uid } from "./flow";

// ============================================================================
// Helpers
// ============================================================================

const PAGE_SIZE = 24;

/** Offset-based cursor: good enough until the community needs keyset paging. */
const cursorSchema = z.number().int().min(0).nullish();

/**
 * Published flows with author and SQL-side bookmark/fork counts, so
 * "popular" can order and paginate in the database.
 */
function publishedCardsQuery() {
  const bookmarkCounts = db
    .select({
      flowId: flowBookmark.flowId,
      bookmarkCount: sql<number>`count(*)::int`.as("bookmark_count"),
    })
    .from(flowBookmark)
    .groupBy(flowBookmark.flowId)
    .as("bookmark_counts");

  const forkCounts = db
    .select({
      forkedFromId: flow.forkedFromId,
      forkCount: sql<number>`count(*)::int`.as("fork_count"),
    })
    .from(flow)
    .where(isNotNull(flow.forkedFromId))
    .groupBy(flow.forkedFromId)
    .as("fork_counts");

  const query = db
    .select({
      id: flow.id,
      name: flow.name,
      color: flow.color,
      description: flow.description,
      publishedYdoc: flow.publishedYdoc,
      publishedAt: flow.publishedAt,
      ownerId: flow.ownerId,
      authorId: user.id,
      authorName: user.name,
      authorImage: user.image,
      authorCollabColor: userSettings.collabColor,
      authorCollabIcon: userSettings.collabIcon,
      bookmarkCount: sql<number>`coalesce(${bookmarkCounts.bookmarkCount}, 0)`,
      forkCount: sql<number>`coalesce(${forkCounts.forkCount}, 0)`,
    })
    .from(flow)
    .innerJoin(user, eq(flow.ownerId, user.id))
    .leftJoin(userSettings, eq(userSettings.userId, flow.ownerId))
    .leftJoin(bookmarkCounts, eq(bookmarkCounts.flowId, flow.id))
    .leftJoin(forkCounts, eq(forkCounts.forkedFromId, flow.id))
    .$dynamic();

  const byPopularity: SQL[] = [
    desc(sql`coalesce(${bookmarkCounts.bookmarkCount}, 0)`),
    desc(flow.publishedAt),
    desc(flow.id),
  ];

  return { query, byPopularity };
}

type CardRow = Awaited<ReturnType<ReturnType<typeof publishedCardsQuery>["query"]["execute"]>>[number];

/**
 * Decode the snapshot and stamp viewer-specific flags onto a page of rows.
 */
async function decorate(rows: CardRow[], viewerId: string | undefined) {
  const flowIds = rows.map((row) => row.id);
  const viewerBookmarks =
    viewerId && flowIds.length
      ? await db.query.flowBookmark.findMany({
          where: and(
            eq(flowBookmark.userId, viewerId),
            inArray(flowBookmark.flowId, flowIds)
          ),
          columns: { flowId: true },
        })
      : [];
  const bookmarkedIds = new Set(viewerBookmarks.map((b) => b.flowId));

  return rows.map((row) => {
    const {
      publishedYdoc,
      ownerId,
      authorId,
      authorName,
      authorImage,
      authorCollabColor,
      authorCollabIcon,
      ...rest
    } = row;
    return {
      ...rest,
      ...decodeFlowData(publishedYdoc),
      author: {
        id: authorId,
        name: authorName,
        image: authorImage,
        collabColor: authorCollabColor ?? "#4338ca",
        collabIcon: authorCollabIcon ?? "Cat",
      },
      isOwn: ownerId === viewerId,
      bookmarked: bookmarkedIds.has(row.id),
    };
  });
}

/** Run a card query one row past the page to learn whether more exist. */
async function page<T extends { limit: (n: number) => { offset: (n: number) => Promise<CardRow[]> } }>(
  query: T,
  cursor: number | null | undefined
) {
  const offset = cursor ?? 0;
  const rows = await query.limit(PAGE_SIZE + 1).offset(offset);
  return {
    rows: rows.slice(0, PAGE_SIZE),
    nextCursor: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
  };
}

async function requirePublishedFlow(id: string) {
  const flowRecord = await db.query.flow.findFirst({
    where: and(eq(flow.id, id), isNotNull(flow.publishedAt)),
  });
  if (!flowRecord) {
    throw new Error("Flow not found");
  }
  return flowRecord;
}

// ============================================================================
// Router — browsing and profiles are public; bookmarking and forking into an
// account require a session. Publishing lives on the flow router (owner-only).
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
    .query(async ({ ctx, input }) => {
      const { query, byPopularity } = publishedCardsQuery();

      const { rows, nextCursor } = await page(
        query
          .where(
            and(
              isNotNull(flow.publishedAt),
              input.search ? ilike(flow.name, `%${input.search}%`) : undefined
            )
          )
          .orderBy(
            ...(input.sort === "popular"
              ? byPopularity
              : [desc(flow.publishedAt), desc(flow.id)])
          ),
        input.cursor
      );

      return {
        items: await decorate(rows, ctx.session?.user.id),
        nextCursor,
      };
    }),

  /**
   * One published flow, full snapshot for the preview page.
   */
  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const { query } = publishedCardsQuery();
      const rows = await query
        .where(and(eq(flow.id, input.id), isNotNull(flow.publishedAt)))
        .limit(1);
      if (!rows.length) {
        throw new Error("Flow not found");
      }
      const [card] = await decorate(rows, ctx.session?.user.id);
      return card;
    }),

  /**
   * Public author profile: the user and their published flows, paginated.
   */
  byAuthor: publicProcedure
    .input(z.object({ userId: z.string(), cursor: cursorSchema }))
    .query(async ({ ctx, input }) => {
      const author = await db.query.user.findFirst({
        where: eq(user.id, input.userId),
        columns: { id: true, name: true, image: true, createdAt: true },
      });
      if (!author) {
        throw new Error("User not found");
      }

      // The identity users actually configure (same as collaborator faces).
      const settings = await db.query.userSettings.findFirst({
        where: eq(userSettings.userId, input.userId),
        columns: { collabColor: true, collabIcon: true },
      });

      const { query, byPopularity } = publishedCardsQuery();
      const { rows, nextCursor } = await page(
        query
          .where(
            and(eq(flow.ownerId, input.userId), isNotNull(flow.publishedAt))
          )
          .orderBy(...byPopularity),
        input.cursor
      );

      const [countRow] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(flow)
        .where(
          and(eq(flow.ownerId, input.userId), isNotNull(flow.publishedAt))
        );

      return {
        total: countRow?.total ?? 0,
        author: {
          ...author,
          collabColor: settings?.collabColor ?? "#4338ca",
          collabIcon: settings?.collabIcon ?? "Cat",
        },
        items: await decorate(rows, ctx.session?.user.id),
        nextCursor,
      };
    }),

  /**
   * The viewer's bookmarked community flows, most recently saved first.
   */
  bookmarks: protectedProcedure
    .input(z.object({ cursor: cursorSchema }))
    .query(async ({ ctx, input }) => {
      const { query } = publishedCardsQuery();
      const { rows, nextCursor } = await page(
        query
          .innerJoin(
            flowBookmark,
            and(
              eq(flowBookmark.flowId, flow.id),
              eq(flowBookmark.userId, ctx.session.user.id)
            )
          )
          .where(isNotNull(flow.publishedAt))
          .orderBy(desc(flowBookmark.createdAt)),
        input.cursor
      );

      return {
        items: await decorate(rows, ctx.session.user.id),
        nextCursor,
      };
    }),

  /**
   * Bookmark or un-bookmark a published flow
   */
  toggleBookmark: protectedProcedure
    .input(z.object({ flowId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const existing = await db.query.flowBookmark.findFirst({
        where: and(
          eq(flowBookmark.flowId, input.flowId),
          eq(flowBookmark.userId, userId)
        ),
      });

      if (existing) {
        await db.delete(flowBookmark).where(eq(flowBookmark.id, existing.id));
        return { bookmarked: false };
      }

      await requirePublishedFlow(input.flowId);
      await db
        .insert(flowBookmark)
        .values({ id: uid(), flowId: input.flowId, userId })
        .onConflictDoNothing();
      return { bookmarked: true };
    }),

  /**
   * Copy a published flow into the caller's own flows.
   * Signed-out users fork client-side into the local flow instead.
   */
  fork: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const source = await requirePublishedFlow(input.id);
      const { nodes, edges } = decodeFlowData(source.publishedYdoc);

      const name = `${source.name} (copy)`.slice(0, 100);
      const flowDoc = FlowDocument.createEmpty();
      flowDoc.setMeta({ name });
      flowDoc.setFlowData(nodes, edges);
      const ydocData = flowDoc.encode();

      const [createdFlow] = await db
        .insert(flow)
        .values({
          id: uid(),
          name,
          color: source.color,
          ownerId: ctx.session.user.id,
          forkedFromId: source.id,
          ydoc: Buffer.from(ydocData),
        })
        .returning({ id: flow.id, name: flow.name });

      flowDoc.destroy();

      return createdFlow;
    }),
});
