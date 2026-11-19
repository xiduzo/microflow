import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@microflow/db";
import { flow, flowBookmark, flowCollaborator, flowInvite } from "@microflow/db/schema/flow";
import { user } from "@microflow/db/schema/auth";
import { userSettings } from "@microflow/db/schema/user-settings";
import { grantAccess } from "@microflow/db/flow-invitation";
import { useTestDb } from "@microflow/db/testing";
import { FlowDocument, RoomGone, yjsServer } from "@microflow/collab/server";
import {
  browseCommunity,
  collabIdentity,
  createFlow,
  deleteFlow,
  forkCommunityFlow,
  getCommunityAuthor,
  getCommunityFlow,
  listBookmarkedFlows,
  listFlows,
  openFlow,
  publishFlow,
  toggleBookmark,
  unpublishFlow,
  updateFlow,
} from "./flow-library";

/**
 * The Flow library through its interface, on the in-process Postgres and the
 * real room server (whose store reads the same database). Nothing is mocked:
 * a "live room" below is a room a connection has joined.
 */

const OWNER = "user-owner";
const OTHER = "user-other";
const THIRD = "user-third";

let db: Db;

async function addUser(id: string, name = id) {
  await db.insert(user).values({ id, name, email: `${id}@example.com` });
}

const node = (id: string) => ({ id, type: "Note", position: { x: 0, y: 0 }, data: {} });
const edge = (id: string, source: string, target: string) => ({
  id,
  source,
  sourceHandle: "out",
  target,
  targetHandle: "in",
});

/** Decode an encoded document into what the assertions care about. */
function read(ydoc: Buffer | string | null | undefined) {
  if (!ydoc) return null;
  const bytes = typeof ydoc === "string" ? Buffer.from(ydoc, "base64") : ydoc;
  const document = FlowDocument.decode(new Uint8Array(bytes));
  const result = {
    name: document.getMeta().name,
    nodes: document.getNodes().map((n) => n.id),
    edges: document.getEdges().map((e) => e.id),
  };
  document.destroy();
  return result;
}

async function row(flowId: string) {
  const [record] = await db.select().from(flow).where(eq(flow.id, flowId));
  return record;
}

/**
 * Put a room in memory for `flowId`, then move the stored row away from it
 * (as a save from another server instance would), so a reader's choice
 * between the room and the row shows: the room holds what the flow was
 * created with, the row holds a single node named `stored-node`.
 */
async function liveRoomAheadOfRow(flowId: string) {
  let closedWith: number | undefined;
  const connection = await yjsServer.join(
    flowId,
    { send: () => {}, close: (code?: number) => void (closedWith = code ?? 1000) },
    OWNER,
    true,
  );
  const stale = FlowDocument.createEmpty();
  stale.setFlowData([node("stored-node")], []);
  await db
    .update(flow)
    .set({ ydoc: Buffer.from(stale.encode()), updatedAt: sql`${flow.updatedAt}` })
    .where(eq(flow.id, flowId));
  stale.destroy();
  return { connection, closedWith: () => closedWith };
}

const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

/** Create and publish a flow; returns its id. */
async function publish(ownerId: string, name: string, nodes = [node("a")]) {
  const created = await createFlow(ownerId, { name, nodes, edges: [] });
  await publishFlow(created!.id);
  // `publishedAt` has millisecond resolution; keep publish order observable.
  await tick();
  return created!.id;
}

beforeEach(async () => {
  db = await useTestDb();
  await addUser(OWNER, "Olive");
  await addUser(OTHER, "Otto");
  await addUser(THIRD, "Thea");
});

// ============================================================================
// Collab identity
// ============================================================================

describe("collabIdentity", () => {
  test("a user with no settings gets the default colour and icon", () => {
    expect(collabIdentity(undefined)).toEqual({ collabColor: "#4338ca", collabIcon: "Cat" });
    expect(collabIdentity({ collabColor: null, collabIcon: null })).toEqual({
      collabColor: "#4338ca",
      collabIcon: "Cat",
    });
  });

  test("what the user configured wins", () => {
    expect(collabIdentity({ collabColor: "#112233", collabIcon: "Dog" })).toEqual({
      collabColor: "#112233",
      collabIcon: "Dog",
    });
  });
});

// ============================================================================
// Creating
// ============================================================================

describe("createFlow", () => {
  test("a new flow is empty, named in its document, and owned by its creator", async () => {
    const created = await createFlow(OWNER, { name: "Blinky" });

    expect(created!.name).toBe("Blinky");
    const record = await row(created!.id);
    expect(record!.ownerId).toBe(OWNER);
    expect(record!.color).toBe("#4338ca");
    expect(record!.forkedFromId).toBeNull();
    expect(record!.publishedAt).toBeNull();
    expect(read(record!.ydoc)).toEqual({ name: "Blinky", nodes: [], edges: [] });
  });

  test("an import carries its nodes, edges and colour", async () => {
    const created = await createFlow(OWNER, {
      name: "Imported",
      color: "#fca5a5",
      nodes: [node("a"), node("b")],
      edges: [edge("a-b", "a", "b")],
    });

    const record = await row(created!.id);
    expect(record!.color).toBe("#fca5a5");
    expect(read(record!.ydoc)).toEqual({ name: "Imported", nodes: ["a", "b"], edges: ["a-b"] });
  });

  test("two flows never share an id", async () => {
    const first = await createFlow(OWNER, { name: "Same" });
    const second = await createFlow(OWNER, { name: "Same" });

    expect(first!.id).not.toBe(second!.id);
  });
});

// ============================================================================
// Reading
// ============================================================================

describe("listFlows", () => {
  test("splits what the user owns from what they collaborate on, with their role", async () => {
    const mine = await createFlow(OWNER, { name: "Mine", nodes: [node("a")], edges: [] });
    const theirs = await createFlow(OTHER, { name: "Theirs" });
    await createFlow(OTHER, { name: "Not shared" });
    await grantAccess(theirs!.id, OWNER, "editor");

    const { owned, collaborated } = await listFlows(OWNER);

    expect(owned.map((f) => [f.id, f.name, f.nodes.map((n) => n.id)])).toEqual([
      [mine!.id, "Mine", ["a"]],
    ]);
    expect(collaborated.map((f) => [f.id, f.role])).toEqual([[theirs!.id, "editor"]]);
  });

  test("people are everyone else on the flow, each with their Collab identity", async () => {
    const created = await createFlow(OWNER, { name: "Shared" });
    await grantAccess(created!.id, OTHER, "viewer");
    await grantAccess(created!.id, THIRD, "editor");
    await db
      .insert(userSettings)
      .values({ id: "s1", userId: OTHER, collabColor: "#112233", collabIcon: "Dog" });

    const asOwner = (await listFlows(OWNER)).owned[0]!;
    expect(asOwner.people.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: OTHER, name: "Otto", role: "viewer", collabColor: "#112233", collabIcon: "Dog" },
      { id: THIRD, name: "Thea", role: "editor", collabColor: "#4338ca", collabIcon: "Cat" },
    ]);

    // A collaborator sees the owner and the other collaborator, not themselves.
    const asViewer = (await listFlows(OTHER)).collaborated[0]!;
    expect(asViewer.people.map((p) => `${p.id}:${p.role}`).sort()).toEqual([
      `${OWNER}:owner`,
      `${THIRD}:editor`,
    ]);
  });

  test("a user with no flows gets two empty lists", async () => {
    await createFlow(OWNER, { name: "Mine" });

    expect(await listFlows(OTHER)).toEqual({ owned: [], collaborated: [] });
  });

  test("previews the live room's document ahead of the stored row", async () => {
    const created = await createFlow(OWNER, { name: "Live", nodes: [node("live-node")], edges: [] });
    const { connection } = await liveRoomAheadOfRow(created!.id);

    const live = await listFlows(OWNER);
    expect(live.owned[0]!.nodes.map((n) => n.id)).toEqual(["live-node"]);

    connection.close();
    const stored = await listFlows(OWNER);
    expect(stored.owned[0]!.nodes.map((n) => n.id)).toEqual(["stored-node"]);
  });
});

describe("openFlow", () => {
  test("returns the document, decoded and encoded, and everyone on the flow", async () => {
    const created = await createFlow(OWNER, {
      name: "Open me",
      nodes: [node("a")],
      edges: [],
    });
    await grantAccess(created!.id, OTHER, "viewer");
    await db
      .insert(userSettings)
      .values({ id: "s1", userId: OWNER, collabColor: "#abcdef", collabIcon: "Fish" });

    const opened = await openFlow((await row(created!.id))!);

    expect(opened.id).toBe(created!.id);
    expect(opened.name).toBe("Open me");
    expect(opened.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(read(opened.ydocBase64)).toEqual({ name: "Open me", nodes: ["a"], edges: [] });
    expect(opened.owner).toEqual({
      id: OWNER,
      name: "Olive",
      email: `${OWNER}@example.com`,
      image: null,
      collabColor: "#abcdef",
      collabIcon: "Fish",
    });
    expect(opened.collaborators).toEqual([
      {
        role: "viewer",
        user: {
          id: OTHER,
          name: "Otto",
          email: `${OTHER}@example.com`,
          image: null,
          collabColor: "#4338ca",
          collabIcon: "Cat",
        },
      },
    ]);
  });

  test("serves the live room's document ahead of the stored row", async () => {
    const created = await createFlow(OWNER, { name: "Live", nodes: [node("live-node")], edges: [] });
    const { connection } = await liveRoomAheadOfRow(created!.id);

    const live = await openFlow((await row(created!.id))!);
    expect(live.nodes.map((n) => n.id)).toEqual(["live-node"]);
    expect(read(live.ydocBase64)!.nodes).toEqual(["live-node"]);

    connection.close();
    const stored = await openFlow((await row(created!.id))!);
    expect(stored.nodes.map((n) => n.id)).toEqual(["stored-node"]);
  });

  test("a flow deleted since the access check is not found", async () => {
    const created = await createFlow(OWNER, { name: "Gone" });
    const record = (await row(created!.id))!;
    await deleteFlow(created!.id);

    await expect(openFlow(record)).rejects.toThrow("Flow not found");
  });
});

// ============================================================================
// Changing
// ============================================================================

describe("updateFlow", () => {
  test("a rename writes the row and the stored document's name", async () => {
    const created = await createFlow(OWNER, { name: "Before", nodes: [node("a")], edges: [] });

    const [updated] = await updateFlow(created!.id, { name: "After" });

    expect(updated!.name).toBe("After");
    const record = await row(created!.id);
    expect(record!.name).toBe("After");
    expect(read(record!.ydoc)).toEqual({ name: "After", nodes: ["a"], edges: [] });
  });

  test("a rename reaches a live room, so collaborators see it without a reload", async () => {
    const created = await createFlow(OWNER, { name: "Before" });
    const connection = await yjsServer.join(
      created!.id,
      { send: () => {}, close: () => {} },
      OWNER,
      true,
    );

    await updateFlow(created!.id, { name: "After" });

    expect(read(Buffer.from(yjsServer.currentState(created!.id)!))!.name).toBe("After");
    yjsServer.dropRoom(created!.id);
    connection.close();
  });

  test("a colour-only update leaves the name and the document alone", async () => {
    const created = await createFlow(OWNER, { name: "Same" });
    const before = (await row(created!.id))!.ydoc!;

    await updateFlow(created!.id, { color: "#112233" });

    const record = await row(created!.id);
    expect(record!.name).toBe("Same");
    expect(record!.color).toBe("#112233");
    expect(record!.ydoc!.equals(before)).toBe(true);
  });

  test(
    "a failed document write does not fail the rename, and the document catches up when the store recovers",
    async () => {
      const created = await createFlow(OWNER, { name: "Before" });
      const documentName = async () => read((await row(created!.id))!.ydoc)!.name;
      // The store cannot take a document write; a row update without `ydoc` can.
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION refuse_document_write() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'store unavailable'; END $$ LANGUAGE plpgsql
      `);
      await db.execute(sql`
        CREATE TRIGGER refuse_document_write BEFORE UPDATE OF ydoc ON flow
        FOR EACH ROW EXECUTE FUNCTION refuse_document_write()
      `);

      const [updated] = await updateFlow(created!.id, { name: "Late" });

      expect(updated!.name).toBe("Late");
      expect((await row(created!.id))!.name).toBe("Late");
      expect(await documentName()).toBe("Before");

      // The store recovers. The mirror's first background retry (one second
      // after the failure) lands the name, which also ends the retries: the
      // test waits for it, so no timer of its is left to fire into a later one.
      await db.execute(sql`DROP TRIGGER refuse_document_write ON flow`);
      const deadline = Date.now() + 5_000;
      while ((await documentName()) !== "Late" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await documentName()).toBe("Late");
    },
    10_000,
  );
});

describe("deleteFlow", () => {
  test("removes the flow and everything that hangs off it", async () => {
    const created = await createFlow(OWNER, { name: "Doomed" });
    await grantAccess(created!.id, OTHER, "editor");
    await publishFlow(created!.id);
    await toggleBookmark(created!.id, OTHER);
    await db.insert(flowInvite).values({
      id: "invite-1",
      flowId: created!.id,
      email: "new@example.com",
      invitedBy: OWNER,
    });

    await deleteFlow(created!.id);

    expect(await row(created!.id)).toBeUndefined();
    expect(await db.select().from(flowCollaborator)).toEqual([]);
    expect(await db.select().from(flowBookmark)).toEqual([]);
    expect(await db.select().from(flowInvite)).toEqual([]);
    expect(await listFlows(OTHER)).toEqual({ owned: [], collaborated: [] });
  });

  test("discards the live room: its sockets close and nobody can rejoin", async () => {
    const created = await createFlow(OWNER, { name: "Doomed" });
    const room = await liveRoomAheadOfRow(created!.id);

    await deleteFlow(created!.id);

    expect(room.closedWith()).toBeDefined();
    expect(yjsServer.currentState(created!.id)).toBeNull();
    await expect(
      yjsServer.join(created!.id, { send: () => {}, close: () => {} }, OWNER, true),
    ).rejects.toBeInstanceOf(RoomGone);
  });
});

// ============================================================================
// Community flows: publishing
// ============================================================================

describe("publishFlow", () => {
  test("freezes the current document; later edits stay private until republished", async () => {
    const created = await createFlow(OWNER, { name: "Blinky", nodes: [node("v1")], edges: [] });

    await publishFlow(created!.id, "First version");
    // The owner keeps working: the stored document moves on.
    const next = FlowDocument.createEmpty();
    next.setFlowData([node("v2")], []);
    await db.update(flow).set({ ydoc: Buffer.from(next.encode()) }).where(eq(flow.id, created!.id));
    next.destroy();

    const published = await getCommunityFlow(created!.id, undefined);
    expect(published.nodes.map((n) => n.id)).toEqual(["v1"]);
    expect(published.description).toBe("First version");

    await publishFlow(created!.id);
    const republished = await getCommunityFlow(created!.id, undefined);
    expect(republished.nodes.map((n) => n.id)).toEqual(["v2"]);
    // Republishing without a description keeps the one it had.
    expect(republished.description).toBe("First version");
  });

  test("snapshots the live room, not the stored row", async () => {
    const created = await createFlow(OWNER, { name: "Live", nodes: [node("live-node")], edges: [] });
    const { connection } = await liveRoomAheadOfRow(created!.id);

    await publishFlow(created!.id);

    const published = await getCommunityFlow(created!.id, undefined);
    expect(published.nodes.map((n) => n.id)).toEqual(["live-node"]);
    connection.close();
  });

  test("is not an edit: updatedAt stays where it was", async () => {
    const created = await createFlow(OWNER, { name: "Blinky" });
    const before = (await row(created!.id))!.updatedAt;
    await tick();

    await publishFlow(created!.id);
    expect((await row(created!.id))!.updatedAt).toEqual(before);
    expect((await row(created!.id))!.publishedAt).not.toBeNull();

    await unpublishFlow(created!.id);
    expect((await row(created!.id))!.updatedAt).toEqual(before);
  });
});

describe("unpublishFlow", () => {
  test("takes the flow out of the Community and drops the snapshot", async () => {
    const flowId = await publish(OWNER, "Blinky");

    await unpublishFlow(flowId);

    expect((await browseCommunity({ sort: "popular" }, undefined)).items).toEqual([]);
    await expect(getCommunityFlow(flowId, undefined)).rejects.toThrow("Flow not found");
    const record = await row(flowId);
    expect(record!.publishedAt).toBeNull();
    expect(record!.publishedYdoc).toBeNull();
    // The flow itself is untouched.
    expect((await listFlows(OWNER)).owned.map((f) => f.id)).toEqual([flowId]);
  });

  test("bookmarks survive an unpublish and count again after a republish", async () => {
    const flowId = await publish(OWNER, "Blinky");
    await toggleBookmark(flowId, OTHER);

    await unpublishFlow(flowId);
    expect((await listBookmarkedFlows(OTHER, null)).items).toEqual([]);

    await publishFlow(flowId);
    const [card] = (await listBookmarkedFlows(OTHER, null)).items;
    expect(card!.id).toBe(flowId);
    expect(card!.bookmarkCount).toBe(1);
  });
});

// ============================================================================
// Community flows: browsing
// ============================================================================

describe("browseCommunity", () => {
  test("lists only published flows, as cards with author, counts and viewer flags", async () => {
    const flowId = await publish(OWNER, "Blinky", [node("a"), node("b")]);
    await createFlow(OWNER, { name: "Private" });
    await db
      .insert(userSettings)
      .values({ id: "s1", userId: OWNER, collabColor: "#abcdef", collabIcon: "Fish" });
    await toggleBookmark(flowId, OTHER);
    await forkCommunityFlow(flowId, THIRD);

    const anonymous = await browseCommunity({ sort: "popular" }, undefined);
    expect(anonymous.nextCursor).toBeNull();
    expect(anonymous.items.length).toBe(1);
    const card = anonymous.items[0]!;
    expect(card).toMatchObject({
      id: flowId,
      name: "Blinky",
      color: "#4338ca",
      description: null,
      bookmarkCount: 1,
      forkCount: 1,
      author: {
        id: OWNER,
        name: "Olive",
        image: null,
        collabColor: "#abcdef",
        collabIcon: "Fish",
      },
      isOwn: false,
      bookmarked: false,
    });
    expect(card.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    // The snapshot and the owner id stay server-side.
    expect(Object.keys(card)).not.toContain("publishedYdoc");
    expect(Object.keys(card)).not.toContain("ownerId");

    const asOwner = (await browseCommunity({ sort: "popular" }, OWNER)).items[0]!;
    expect([asOwner.isOwn, asOwner.bookmarked]).toEqual([true, false]);
    const asFan = (await browseCommunity({ sort: "popular" }, OTHER)).items[0]!;
    expect([asFan.isOwn, asFan.bookmarked]).toEqual([false, true]);
  });

  test("popular orders by bookmarks, then by most recently published", async () => {
    const older = await publish(OWNER, "Older");
    const loved = await publish(OWNER, "Loved");
    const newer = await publish(OWNER, "Newer");
    const adored = await publish(OWNER, "Adored");
    await toggleBookmark(loved, OTHER);
    await toggleBookmark(adored, OTHER);
    await toggleBookmark(adored, THIRD);

    const popular = await browseCommunity({ sort: "popular" }, undefined);
    expect(ids(popular.items)).toEqual([adored, loved, newer, older]);
    expect(popular.items.map((card) => card.bookmarkCount)).toEqual([2, 1, 0, 0]);

    const recent = await browseCommunity({ sort: "recent" }, undefined);
    expect(ids(recent.items)).toEqual([adored, newer, loved, older]);
  });

  test("search matches part of the name, whatever its case", async () => {
    const blinky = await publish(OWNER, "Blinky Lights");
    await publish(OWNER, "Thermostat");

    const found = await browseCommunity({ sort: "popular", search: "LIGHT" }, undefined);

    expect(ids(found.items)).toEqual([blinky]);
  });

  test("pages 24 at a time, and the pages neither overlap nor miss a flow", async () => {
    const published: string[] = [];
    for (let i = 0; i < 30; i++) {
      const created = await createFlow(OWNER, { name: `Flow ${i}` });
      await publishFlow(created!.id);
      published.push(created!.id);
    }

    const first = await browseCommunity({ sort: "popular" }, undefined);
    expect(first.items.length).toBe(24);
    expect(first.nextCursor).toBe(24);

    const second = await browseCommunity({ sort: "popular", cursor: first.nextCursor }, undefined);
    expect(second.items.length).toBe(6);
    expect(second.nextCursor).toBeNull();

    expect([...ids(first.items), ...ids(second.items)].sort()).toEqual([...published].sort());
  });

  test("a page that ends exactly on the last flow has no next page", async () => {
    for (let i = 0; i < 24; i++) {
      const created = await createFlow(OWNER, { name: `Flow ${i}` });
      await publishFlow(created!.id);
    }

    const only = await browseCommunity({ sort: "recent" }, undefined);

    expect(only.items.length).toBe(24);
    expect(only.nextCursor).toBeNull();
  });
});

describe("getCommunityFlow", () => {
  test("a flow that is not published is not found, even for its owner", async () => {
    const created = await createFlow(OWNER, { name: "Private" });

    await expect(getCommunityFlow(created!.id, OWNER)).rejects.toThrow("Flow not found");
    await expect(getCommunityFlow("no-such-flow", undefined)).rejects.toThrow("Flow not found");
  });
});

describe("a published flow whose document holds malformed edges", () => {
  /** Publish a flow, then make its snapshot hold `wired` and every kind of malformed edge. */
  async function publishedWithMalformedEdges() {
    const source = await publish(OWNER, "Blinky", [node("a"), node("b")]);
    const snapshot = FlowDocument.createEmpty();
    snapshot.setFlowData([node("a"), node("b")], [edge("wired", "a", "b")]);
    snapshot.doc.transact(() => {
      const raw = snapshot.edges as unknown as Map<string, unknown>;
      raw.set("not-an-edge", 7);
      raw.set("no-id", { source: "a", sourceHandle: "out", target: "b", targetHandle: "in" });
      raw.set("odd-source", { ...edge("odd-source", "a", "b"), source: 3 });
      raw.set("odd-handle", { ...edge("odd-handle", "a", "b"), targetHandle: { x: 1 } });
      raw.set("no-handle", { id: "no-handle", source: "a", target: "b" });
    });
    await db
      .update(flow)
      .set({ publishedYdoc: Buffer.from(snapshot.encode()) })
      .where(eq(flow.id, source));
    snapshot.destroy();
    return source;
  }

  test("the Community is given only the edges the app can use", async () => {
    const source = await publishedWithMalformedEdges();

    const published = await getCommunityFlow(source, undefined);

    expect(published.edges).toEqual([edge("wired", "a", "b")]);
  });

  test("a fork holds only the edges the app can use", async () => {
    const source = await publishedWithMalformedEdges();

    const fork = await forkCommunityFlow(source, OTHER);

    expect(read((await row(fork!.id))!.ydoc)!.edges).toEqual(["wired"]);
    const copy = FlowDocument.decode(new Uint8Array((await row(fork!.id))!.ydoc!));
    expect(copy.getEdgeIds()).toEqual(["wired"]);
    copy.destroy();
  });
});

describe("getCommunityAuthor", () => {
  test("returns the maker, their published total, and only their published flows", async () => {
    const first = await publish(OWNER, "First");
    const second = await publish(OWNER, "Second");
    await createFlow(OWNER, { name: "Private" });
    await publish(OTHER, "Somebody else's");
    await toggleBookmark(first, THIRD);
    await db
      .insert(userSettings)
      .values({ id: "s1", userId: OWNER, collabColor: "#abcdef", collabIcon: "Fish" });

    const profile = await getCommunityAuthor(OWNER, null, THIRD);

    expect(profile.total).toBe(2);
    expect(profile.author).toMatchObject({
      id: OWNER,
      name: "Olive",
      image: null,
      collabColor: "#abcdef",
      collabIcon: "Fish",
    });
    expect(profile.author.createdAt).toBeInstanceOf(Date);
    // Most bookmarked first.
    expect(ids(profile.items)).toEqual([first, second]);
    expect(profile.items.map((card) => card.bookmarked)).toEqual([true, false]);
    expect(profile.nextCursor).toBeNull();
  });

  test("a maker with nothing published has an empty profile, with the default identity", async () => {
    const profile = await getCommunityAuthor(OTHER, null, undefined);

    expect(profile.total).toBe(0);
    expect(profile.items).toEqual([]);
    expect(profile.author).toMatchObject({ id: OTHER, collabColor: "#4338ca", collabIcon: "Cat" });
  });

  test("an unknown user is not found", async () => {
    await expect(getCommunityAuthor("nobody", null, undefined)).rejects.toThrow("User not found");
  });
});

// ============================================================================
// Community flows: bookmarks
// ============================================================================

describe("toggleBookmark", () => {
  const bookmarkCount = async (flowId: string) =>
    (await getCommunityFlow(flowId, undefined)).bookmarkCount;

  test("the first toggle bookmarks, the second removes it", async () => {
    const flowId = await publish(OWNER, "Blinky");

    expect(await toggleBookmark(flowId, OTHER)).toEqual({ bookmarked: true });
    expect(await bookmarkCount(flowId)).toBe(1);
    expect((await getCommunityFlow(flowId, OTHER)).bookmarked).toBe(true);

    expect(await toggleBookmark(flowId, OTHER)).toEqual({ bookmarked: false });
    expect(await bookmarkCount(flowId)).toBe(0);
    expect((await getCommunityFlow(flowId, OTHER)).bookmarked).toBe(false);
  });

  // Not a concurrency test: the in-process Postgres has one connection, so
  // the two calls only interleave statement by statement. Both look for an
  // existing bookmark before either inserts, and both then insert. What this
  // pins is that the unique index on (flow, user) with ON CONFLICT DO NOTHING
  // absorbs the second insert. It says nothing about two transactions racing
  // on separate connections.
  test("two toggles whose statements interleave insert twice and keep one bookmark", async () => {
    const flowId = await publish(OWNER, "Blinky");

    const results = await Promise.all([
      toggleBookmark(flowId, OTHER),
      toggleBookmark(flowId, OTHER),
    ]);

    expect(results).toEqual([{ bookmarked: true }, { bookmarked: true }]);
    expect(await bookmarkCount(flowId)).toBe(1);
    expect((await db.select().from(flowBookmark)).length).toBe(1);
  });

  test("each user's bookmark is their own", async () => {
    const flowId = await publish(OWNER, "Blinky");
    await toggleBookmark(flowId, OTHER);
    await toggleBookmark(flowId, THIRD);

    await toggleBookmark(flowId, OTHER);

    expect(await bookmarkCount(flowId)).toBe(1);
    expect((await getCommunityFlow(flowId, THIRD)).bookmarked).toBe(true);
  });

  test("a flow that is not published cannot be bookmarked", async () => {
    const created = await createFlow(OWNER, { name: "Private" });

    await expect(toggleBookmark(created!.id, OTHER)).rejects.toThrow("Flow not found");
    await expect(toggleBookmark("no-such-flow", OTHER)).rejects.toThrow("Flow not found");
    expect(await db.select().from(flowBookmark)).toEqual([]);
  });

  test("a bookmark can still be removed after the flow is unpublished", async () => {
    const flowId = await publish(OWNER, "Blinky");
    await toggleBookmark(flowId, OTHER);
    await unpublishFlow(flowId);

    expect(await toggleBookmark(flowId, OTHER)).toEqual({ bookmarked: false });
    expect(await db.select().from(flowBookmark)).toEqual([]);
  });
});

describe("listBookmarkedFlows", () => {
  test("lists the user's own bookmarks, most recently saved first", async () => {
    const first = await publish(OWNER, "First");
    const second = await publish(OWNER, "Second");
    const third = await publish(OWNER, "Third");
    await toggleBookmark(second, OTHER);
    await tick();
    await toggleBookmark(first, OTHER);
    await toggleBookmark(third, THIRD);

    const mine = await listBookmarkedFlows(OTHER, null);

    expect(ids(mine.items)).toEqual([first, second]);
    expect(mine.items.every((card) => card.bookmarked)).toBe(true);
    expect(mine.nextCursor).toBeNull();
  });
});

// ============================================================================
// Community flows: forking
// ============================================================================

describe("forkCommunityFlow", () => {
  test("copies the published snapshot into the forker's own flows", async () => {
    const source = await createFlow(OWNER, {
      name: "Blinky",
      color: "#fca5a5",
      nodes: [node("a"), node("b")],
      edges: [edge("a-b", "a", "b")],
    });
    await publishFlow(source!.id);

    const fork = await forkCommunityFlow(source!.id, OTHER);

    expect(fork!.name).toBe("Blinky (copy)");
    const record = await row(fork!.id);
    expect(record!.ownerId).toBe(OTHER);
    expect(record!.forkedFromId).toBe(source!.id);
    expect(record!.color).toBe("#fca5a5");
    expect(read(record!.ydoc)).toEqual({
      name: "Blinky (copy)",
      nodes: ["a", "b"],
      edges: ["a-b"],
    });
    expect((await listFlows(OTHER)).owned.map((f) => f.id)).toEqual([fork!.id]);
  });

  test("a fork is private until its owner publishes it", async () => {
    const source = await publish(OWNER, "Blinky");

    const fork = await forkCommunityFlow(source, OTHER);

    expect((await row(fork!.id))!.publishedAt).toBeNull();
    expect(ids((await browseCommunity({ sort: "recent" }, undefined)).items)).toEqual([source]);
  });

  test("copies what was published, not what the author has done since", async () => {
    const source = await createFlow(OWNER, { name: "Blinky", nodes: [node("v1")], edges: [] });
    await publishFlow(source!.id);
    const next = FlowDocument.createEmpty();
    next.setFlowData([node("v2")], []);
    await db.update(flow).set({ ydoc: Buffer.from(next.encode()) }).where(eq(flow.id, source!.id));
    next.destroy();

    const fork = await forkCommunityFlow(source!.id, OTHER);

    expect(read((await row(fork!.id))!.ydoc)!.nodes).toEqual(["v1"]);
  });

  test("each fork counts once on its source, and only there", async () => {
    const source = await publish(OWNER, "Blinky");
    const unrelated = await publish(OWNER, "Unrelated");

    await forkCommunityFlow(source, OTHER);
    await forkCommunityFlow(source, OTHER);
    const thirdFork = await forkCommunityFlow(source, THIRD);

    expect((await getCommunityFlow(source, undefined)).forkCount).toBe(3);
    expect((await getCommunityFlow(unrelated, undefined)).forkCount).toBe(0);

    // A deleted fork stops counting.
    await deleteFlow(thirdFork!.id);
    expect((await getCommunityFlow(source, undefined)).forkCount).toBe(2);
  });

  test("the copy's name is cut to fit the 100-character limit", async () => {
    const source = await publish(OWNER, "x".repeat(100));

    const fork = await forkCommunityFlow(source, OTHER);

    expect(fork!.name.length).toBe(100);
  });

  test("a flow that is not published cannot be forked", async () => {
    const created = await createFlow(OWNER, { name: "Private" });

    await expect(forkCommunityFlow(created!.id, OTHER)).rejects.toThrow("Flow not found");
    expect((await listFlows(OTHER)).owned).toEqual([]);
  });
});
