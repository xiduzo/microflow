import { and, desc, eq, ilike, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { db } from "@microflow/db";
import { flow, flowBookmark, flowCollaborator } from "@microflow/db/schema/flow";
import { user } from "@microflow/db/schema/auth";
import { DEFAULT_COLLAB_IDENTITY, userSettings } from "@microflow/db/schema/user-settings";
import { FlowDocument, yjsServer, type FlowEdge, type FlowNode } from "@microflow/collab/server";
import { mirrorNameToDocument } from "./flow-rename";

/**
 * The Flow library: the one module that owns the flow row and its documents.
 *
 * A cloud flow is a row plus two Yjs documents: `ydoc`, which collaborators
 * edit (the live room holds the current copy while one is loaded), and
 * `publishedYdoc`, the frozen snapshot the Community sees. Everything that
 * creates, reads, renames, publishes, lists, bookmarks or forks a flow goes
 * through here, so those rules are stated once:
 *
 * - A new flow starts from content: nothing (new), nodes and edges (import),
 *   or a Community flow's snapshot (fork). All three build the document the
 *   same way.
 * - Readers take the live room's document ahead of the stored one.
 * - Publishing snapshots the current document; later edits stay private until
 *   the next publish. A flow is a Community flow while `publishedAt` is set.
 * - Popularity is the bookmark count; fork counts derive from `forkedFromId`.
 * - People shown next to a flow carry their Collab identity.
 *
 * It does not decide who may call it. The routers run the Flow Access check
 * (`requireFlowAccess`, `flow-access.ts`) and then make one call into here.
 */

// ============================================================================
// Errors
// ============================================================================

/** What the library was asked for is not there (or is not published). */
export class FlowLibraryNotFound extends Error {
  constructor(readonly what: "flow" | "user") {
    super(what === "flow" ? "Flow not found" : "User not found");
    this.name = "FlowLibraryNotFound";
  }
}

// ============================================================================
// Collab identity
// ============================================================================

/** The colour and icon a user appears with next to a flow and in a room. */
export type CollabIdentity = { collabColor: string; collabIcon: string };

/** A user's Collab identity, falling back to the default for what is unset. */
export function collabIdentity(
  settings: { collabColor?: string | null; collabIcon?: string | null } | null | undefined,
): CollabIdentity {
  return {
    collabColor: settings?.collabColor ?? DEFAULT_COLLAB_IDENTITY.collabColor,
    collabIcon: settings?.collabIcon ?? DEFAULT_COLLAB_IDENTITY.collabIcon,
  };
}

/** One settings query for a whole set of people; returns the lookup. */
async function identitiesOf(userIds: string[]): Promise<(userId: string) => CollabIdentity> {
  const ids = [...new Set(userIds)];
  const rows = ids.length
    ? await db.query.userSettings.findMany({
        where: inArray(userSettings.userId, ids),
        columns: { userId: true, collabColor: true, collabIcon: true },
      })
    : [];
  const byUser = new Map(rows.map((row) => [row.userId, row]));
  return (userId) => collabIdentity(byUser.get(userId));
}

// ============================================================================
// Documents
// ============================================================================

const uid = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

/**
 * The flow's document as collaborators see it right now. `flow.ydoc` trails a
 * live room by up to the persist ceiling (or longer while the store is
 * failing), so readers take the room's state when one is loaded.
 */
function currentYdoc(flowId: string, stored: Buffer | null): Buffer | null {
  const live = yjsServer.currentState(flowId);
  return live ? Buffer.from(live) : stored;
}

/** Nodes and edges of an encoded document; an unreadable one reads as empty. */
function readDocument(ydoc: Buffer | null): { nodes: FlowNode[]; edges: FlowEdge[] } {
  if (!ydoc) return { nodes: [], edges: [] };
  let document: FlowDocument | undefined;
  try {
    document = FlowDocument.decode(new Uint8Array(ydoc));
    return document.getFlowData();
  } catch {
    return { nodes: [], edges: [] };
  } finally {
    document?.destroy();
  }
}

type FlowContent = { name: string; nodes?: FlowNode[]; edges?: FlowEdge[] };

/** A fresh document carrying `content`; the name goes into its meta too. */
function writeDocument(content: FlowContent): Buffer {
  const document = FlowDocument.createEmpty();
  try {
    document.setMeta({ name: content.name });
    if (content.nodes || content.edges) {
      document.setFlowData(content.nodes ?? [], content.edges ?? []);
    }
    return Buffer.from(document.encode());
  } finally {
    document.destroy();
  }
}

// ============================================================================
// Flows
// ============================================================================

/** The one way a flow row comes into being. */
async function insertFlow(
  ownerId: string,
  content: FlowContent & { color?: string; forkedFromId?: string },
) {
  const [created] = await db
    .insert(flow)
    .values({
      id: uid(),
      name: content.name,
      color: content.color,
      ownerId,
      forkedFromId: content.forkedFromId,
      ydoc: writeDocument(content),
    })
    .returning({ id: flow.id, name: flow.name });
  return created;
}

/**
 * Create a flow owned by `ownerId`: empty, or holding the given nodes and
 * edges (an import).
 */
export async function createFlow(
  ownerId: string,
  content: FlowContent & { color?: string },
) {
  return insertFlow(ownerId, {
    name: content.name,
    color: content.color,
    nodes: content.nodes,
    edges: content.edges,
  });
}

const PERSON = { id: true, name: true } as const;
const PERSON_WITH_CONTACT = { id: true, name: true, email: true, image: true } as const;

/**
 * Every flow `userId` owns or collaborates on, each with its current nodes
 * and edges and the other people on it ("shared with": owner and
 * collaborators, minus the user).
 */
export async function listFlows(userId: string) {
  const withPeople = {
    owner: { columns: PERSON },
    collaborators: { columns: { role: true }, with: { user: { columns: PERSON } } },
  } as const;
  const columns = {
    id: true,
    name: true,
    color: true,
    createdAt: true,
    updatedAt: true,
    ydoc: true,
  } as const;

  const owned = await db.query.flow.findMany({
    where: eq(flow.ownerId, userId),
    columns,
    with: withPeople,
  });
  const collaborations = await db.query.flowCollaborator.findMany({
    where: eq(flowCollaborator.userId, userId),
    with: { flow: { columns, with: withPeople } },
  });

  const involved = [...owned, ...collaborations.map((collaboration) => collaboration.flow)];
  const identityOf = await identitiesOf(
    involved.flatMap((f) => [f.owner.id, ...f.collaborators.map((c) => c.user.id)]),
  );

  const listed = (f: (typeof involved)[number]) => {
    const { ydoc, owner, collaborators, ...row } = f;
    const people = [
      { ...owner, role: "owner" as const },
      ...collaborators.map((c) => ({ ...c.user, role: c.role })),
    ]
      .filter((person) => person.id !== userId)
      .map((person) => ({ ...person, ...identityOf(person.id) }));
    return { ...row, ...readDocument(currentYdoc(f.id, ydoc)), people };
  };

  return {
    owned: owned.map(listed),
    collaborated: collaborations.map((collaboration) => ({
      ...listed(collaboration.flow),
      role: collaboration.role,
    })),
  };
}

/**
 * One flow for the editor: its current document (decoded, and encoded for the
 * client to initialise from) and everyone on it with their Collab identity.
 * `flowRecord` is the row the Flow Access check returned.
 */
export async function openFlow(flowRecord: typeof flow.$inferSelect) {
  const people = await db.query.flow.findFirst({
    where: eq(flow.id, flowRecord.id),
    columns: { id: true },
    with: {
      owner: { columns: PERSON_WITH_CONTACT },
      collaborators: {
        columns: { role: true },
        with: { user: { columns: PERSON_WITH_CONTACT } },
      },
    },
  });
  if (!people) throw new FlowLibraryNotFound("flow");

  const identityOf = await identitiesOf([
    people.owner.id,
    ...people.collaborators.map((c) => c.user.id),
  ]);
  const ydoc = currentYdoc(flowRecord.id, flowRecord.ydoc);

  return {
    id: flowRecord.id,
    name: flowRecord.name,
    color: flowRecord.color,
    createdAt: flowRecord.createdAt,
    updatedAt: flowRecord.updatedAt,
    owner: { ...people.owner, ...identityOf(people.owner.id) },
    collaborators: people.collaborators.map((c) => ({
      ...c,
      user: { ...c.user, ...identityOf(c.user.id) },
    })),
    ...readDocument(ydoc),
    ydocBase64: ydoc ? ydoc.toString("base64") : null,
  };
}

/**
 * Change a flow's name or colour. The row owns the name; the document carries
 * a copy (export and sketch filenames read it), so a rename is mirrored into
 * the live room, or the stored document when none is open. Best-effort: the
 * row has committed, so a failed document write does not fail the rename.
 */
export async function updateFlow(flowId: string, changes: { name?: string; color?: string }) {
  const updated = await db
    .update(flow)
    .set({ name: changes.name, color: changes.color, updatedAt: new Date() })
    .where(eq(flow.id, flowId))
    .returning();

  if (changes.name !== undefined) {
    await mirrorNameToDocument(flowId, changes.name, (id, meta) => yjsServer.writeMeta(id, meta));
  }

  return updated;
}

/** Delete a flow, and discard its live room rather than let it save back. */
export async function deleteFlow(flowId: string): Promise<void> {
  await db.delete(flow).where(eq(flow.id, flowId));
  yjsServer.dropRoom(flowId);
}

// ============================================================================
// Community flows
// ============================================================================

const isPublished = isNotNull(flow.publishedAt);

/**
 * Publish (or republish) a flow to the Community: freeze the current document
 * into the public snapshot. Publishing is not an edit, so `updatedAt` stays.
 */
export async function publishFlow(flowId: string, description?: string): Promise<void> {
  // The live room when there is one; otherwise the stored document, copied
  // inside the statement so a save landing meanwhile cannot be missed.
  const live = yjsServer.currentState(flowId);
  await db
    .update(flow)
    .set({
      publishedYdoc: live ? Buffer.from(live) : sql`${flow.ydoc}`,
      publishedAt: new Date(),
      description,
      updatedAt: sql`${flow.updatedAt}`,
    })
    .where(eq(flow.id, flowId));
}

/** Take a flow out of the Community. Its bookmarks and forks stay. */
export async function unpublishFlow(flowId: string): Promise<void> {
  await db
    .update(flow)
    .set({ publishedYdoc: null, publishedAt: null, updatedAt: sql`${flow.updatedAt}` })
    .where(eq(flow.id, flowId));
}

const PAGE_SIZE = 24;

/** Offset-based: good enough until the Community needs keyset paging. */
type Cursor = number | null | undefined;

/**
 * Community flows with author and SQL-side bookmark and fork counts, so
 * "popular" can order and paginate in the database.
 */
function communityCards() {
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

type CardRow = Awaited<ReturnType<ReturnType<typeof communityCards>["query"]["execute"]>>[number];

/** Decode the snapshot and stamp viewer-specific flags onto a page of rows. */
async function decorate(rows: CardRow[], viewerId: string | undefined) {
  const flowIds = rows.map((row) => row.id);
  const viewerBookmarks =
    viewerId && flowIds.length
      ? await db.query.flowBookmark.findMany({
          where: and(eq(flowBookmark.userId, viewerId), inArray(flowBookmark.flowId, flowIds)),
          columns: { flowId: true },
        })
      : [];
  const bookmarkedIds = new Set(viewerBookmarks.map((bookmark) => bookmark.flowId));

  return rows.map((row) => {
    const {
      publishedYdoc,
      ownerId,
      authorId,
      authorName,
      authorImage,
      authorCollabColor,
      authorCollabIcon,
      ...card
    } = row;
    return {
      ...card,
      ...readDocument(publishedYdoc),
      author: {
        id: authorId,
        name: authorName,
        image: authorImage,
        ...collabIdentity({ collabColor: authorCollabColor, collabIcon: authorCollabIcon }),
      },
      isOwn: ownerId === viewerId,
      bookmarked: bookmarkedIds.has(row.id),
    };
  });
}

/** Run a card query one row past the page to learn whether more exist. */
async function page<
  T extends { limit: (n: number) => { offset: (n: number) => Promise<CardRow[]> } },
>(query: T, cursor: Cursor, viewerId: string | undefined) {
  const offset = cursor ?? 0;
  const rows = await query.limit(PAGE_SIZE + 1).offset(offset);
  return {
    items: await decorate(rows.slice(0, PAGE_SIZE), viewerId),
    nextCursor: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
  };
}

/**
 * A page of Community flows, most bookmarked first (or most recently
 * published), optionally narrowed to names containing `search`. `viewerId`
 * is the signed-in viewer, if any: it only sets `isOwn` and `bookmarked`.
 */
export async function browseCommunity(
  options: { search?: string; sort: "popular" | "recent"; cursor?: Cursor },
  viewerId: string | undefined,
) {
  const { query, byPopularity } = communityCards();
  return page(
    query
      .where(and(isPublished, options.search ? ilike(flow.name, `%${options.search}%`) : undefined))
      .orderBy(
        ...(options.sort === "popular" ? byPopularity : [desc(flow.publishedAt), desc(flow.id)]),
      ),
    options.cursor,
    viewerId,
  );
}

/** One Community flow, with its full snapshot. */
export async function getCommunityFlow(flowId: string, viewerId: string | undefined) {
  const { query } = communityCards();
  const rows = await query.where(and(eq(flow.id, flowId), isPublished)).limit(1);
  const [card] = await decorate(rows, viewerId);
  if (!card) throw new FlowLibraryNotFound("flow");
  return card;
}

/**
 * A maker's public profile: who they are (with the Collab identity they
 * configured), how many flows they have published, and a page of those flows,
 * most bookmarked first.
 */
export async function getCommunityAuthor(
  authorId: string,
  cursor: Cursor,
  viewerId: string | undefined,
) {
  const author = await db.query.user.findFirst({
    where: eq(user.id, authorId),
    columns: { id: true, name: true, image: true, createdAt: true },
  });
  if (!author) throw new FlowLibraryNotFound("user");

  const identityOf = await identitiesOf([authorId]);
  const theirs = and(eq(flow.ownerId, authorId), isPublished);

  const { query, byPopularity } = communityCards();
  const { items, nextCursor } = await page(
    query.where(theirs).orderBy(...byPopularity),
    cursor,
    viewerId,
  );
  const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(flow).where(theirs);

  return {
    total: count?.total ?? 0,
    author: { ...author, ...identityOf(authorId) },
    items,
    nextCursor,
  };
}

/** The Community flows `userId` bookmarked, most recently saved first. */
export async function listBookmarkedFlows(userId: string, cursor: Cursor) {
  const { query } = communityCards();
  return page(
    query
      .innerJoin(
        flowBookmark,
        and(eq(flowBookmark.flowId, flow.id), eq(flowBookmark.userId, userId)),
      )
      .where(isPublished)
      .orderBy(desc(flowBookmark.createdAt)),
    cursor,
    userId,
  );
}

async function requireCommunityFlow(flowId: string) {
  const published = await db.query.flow.findFirst({ where: and(eq(flow.id, flowId), isPublished) });
  if (!published) throw new FlowLibraryNotFound("flow");
  return published;
}

/**
 * Bookmark a Community flow, or remove the bookmark `userId` already has.
 * A user holds at most one bookmark per flow. Removing works on a flow that
 * has since been unpublished; adding does not.
 */
export async function toggleBookmark(
  flowId: string,
  userId: string,
): Promise<{ bookmarked: boolean }> {
  const existing = await db.query.flowBookmark.findFirst({
    where: and(eq(flowBookmark.flowId, flowId), eq(flowBookmark.userId, userId)),
  });
  if (existing) {
    await db.delete(flowBookmark).where(eq(flowBookmark.id, existing.id));
    return { bookmarked: false };
  }

  await requireCommunityFlow(flowId);
  await db.insert(flowBookmark).values({ id: uid(), flowId, userId }).onConflictDoNothing();
  return { bookmarked: true };
}

/**
 * Copy a Community flow into `ownerId`'s own flows: the published snapshot,
 * never the author's live document. The copy records where it came from
 * (`forkedFromId`), which is what the source's fork count counts.
 */
export async function forkCommunityFlow(flowId: string, ownerId: string) {
  const source = await requireCommunityFlow(flowId);
  return insertFlow(ownerId, {
    name: `${source.name} (copy)`.slice(0, 100),
    color: source.color,
    forkedFromId: source.id,
    ...readDocument(source.publishedYdoc),
  });
}
