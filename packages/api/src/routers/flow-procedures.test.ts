import { beforeEach, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { InviteNotice } from "@microflow/db/flow-invitation";
import { user } from "@microflow/db/schema/auth";
import { useTestDb } from "@microflow/db/testing";

/**
 * The flow and community procedures as the web app calls them: who may call
 * what (Flow Role per procedure), and that a refused call changes nothing.
 * The database is the in-process Postgres and the rooms are the real room
 * server.
 *
 * One narrow fake remains, and it is not about the database: the production
 * invite mailer reaches Resend and the server env at import, so a recording
 * mailer stands in for it.
 */
const sent: InviteNotice[] = [];
mock.module("./invite-mailer", () => ({
  resendInviteMailer: async (notice: InviteNotice) => void sent.push(notice),
}));

const { flowRouter } = await import("./flow");
const { communityRouter } = await import("./community");

const OWNER = "user-owner";
const EDITOR = "user-editor";
const VIEWER = "user-viewer";
const STRANGER = "user-stranger";

const as = (userId: string | null) => {
  const ctx = {
    session: userId
      ? { user: { id: userId, name: userId, email: `${userId}@example.com` } }
      : null,
  } as never;
  return { flow: flowRouter.createCaller(ctx), community: communityRouter.createCaller(ctx) };
};

let flowId: string;

beforeEach(async () => {
  const db = await useTestDb();
  sent.length = 0;
  await db.insert(user).values(
    [OWNER, EDITOR, VIEWER, STRANGER].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
    })),
  );
  const created = await as(OWNER).flow.create({ name: "Blinky" });
  flowId = created!.id;
  await as(OWNER).flow.addCollaborator({ flowId, userId: EDITOR, role: "editor" });
  await as(OWNER).flow.addCollaborator({ flowId, userId: VIEWER, role: "viewer" });
});

describe("reading a flow", () => {
  test("Owner, Editor and Viewer each open it with their own role", async () => {
    const opened = await Promise.all(
      [OWNER, EDITOR, VIEWER].map((userId) => as(userId).flow.get({ id: flowId })),
    );

    expect(opened.map((f) => [f.role, f.isOwner])).toEqual([
      ["owner", true],
      ["editor", false],
      ["viewer", false],
    ]);
    expect(opened[2]!.owner.id).toBe(OWNER);
    expect(opened[2]!.collaborators.map((c) => `${c.user.id}:${c.role}`).sort()).toEqual([
      `${EDITOR}:editor`,
      `${VIEWER}:viewer`,
    ]);
  });

  test("a stranger is denied, and a missing flow is not found", async () => {
    await expect(as(STRANGER).flow.get({ id: flowId })).rejects.toThrow("Access denied");
    await expect(as(STRANGER).flow.publishInfo({ id: flowId })).rejects.toThrow("Access denied");
    await expect(as(OWNER).flow.get({ id: "no-such-flow" })).rejects.toThrow("Flow not found");
  });

  test("each user's list holds what they own and what is shared with them", async () => {
    const owner = await as(OWNER).flow.list();
    const viewer = await as(VIEWER).flow.list();
    const stranger = await as(STRANGER).flow.list();

    expect(owner.owned.map((f) => f.id)).toEqual([flowId]);
    expect(viewer.owned).toEqual([]);
    expect(viewer.collaborated.map((f) => [f.id, f.role])).toEqual([[flowId, "viewer"]]);
    expect(stranger).toEqual({ owned: [], collaborated: [] });
  });

  test("a Viewer can read the published state", async () => {
    await as(OWNER).flow.publish({ id: flowId, description: "Blinks an LED" });

    const info = await as(VIEWER).flow.publishInfo({ id: flowId });

    expect(info.description).toBe("Blinks an LED");
    expect(info.publishedAt).toBeInstanceOf(Date);
  });
});

describe("Owner-only procedures", () => {
  const ownerOnly: Array<[string, (caller: ReturnType<typeof as>) => Promise<unknown>]> = [
    ["update", (c) => c.flow.update({ id: flowId, name: "Hijacked" })],
    ["delete", (c) => c.flow.delete({ id: flowId })],
    ["publish", (c) => c.flow.publish({ id: flowId })],
    ["unpublish", (c) => c.flow.unpublish({ id: flowId })],
    ["addCollaborator", (c) => c.flow.addCollaborator({ flowId, userId: STRANGER, role: "editor" })],
    ["removeCollaborator", (c) => c.flow.removeCollaborator({ flowId, userId: VIEWER })],
    [
      "updateCollaboratorRole",
      (c) => c.flow.updateCollaboratorRole({ flowId, userId: VIEWER, role: "editor" }),
    ],
    [
      "addCollaboratorByEmail",
      (c) => c.flow.addCollaboratorByEmail({ flowId, email: "new@example.com", role: "editor" }),
    ],
    ["pendingInvites", (c) => c.flow.pendingInvites({ flowId })],
    ["revokeInvite", (c) => c.flow.revokeInvite({ flowId, email: "new@example.com" })],
  ];

  test.each(ownerOnly)("%s is refused to an Editor, a Viewer and a stranger", async (_name, call) => {
    for (const userId of [EDITOR, VIEWER, STRANGER]) {
      await expect(call(as(userId))).rejects.toThrow("Access denied");
    }

    // Nothing a refused caller asked for happened.
    const flow = await as(OWNER).flow.get({ id: flowId });
    expect(flow.name).toBe("Blinky");
    expect(flow.collaborators.map((c) => `${c.user.id}:${c.role}`).sort()).toEqual([
      `${EDITOR}:editor`,
      `${VIEWER}:viewer`,
    ]);
    expect((await as(OWNER).flow.publishInfo({ id: flowId })).publishedAt).toBeNull();
    expect(await as(OWNER).flow.pendingInvites({ flowId })).toEqual([]);
    expect(sent).toEqual([]);
  });

  test.each(ownerOnly)("%s on a flow that does not exist is not found", async (_name, call) => {
    await as(OWNER).flow.delete({ id: flowId });

    await expect(call(as(OWNER))).rejects.toThrow("Flow not found");
  });

  test("the Owner renames, recolours, publishes, unpublishes and deletes", async () => {
    const owner = as(OWNER);

    const [updated] = await owner.flow.update({ id: flowId, name: "Renamed", color: "#112233" });
    expect([updated!.name, updated!.color]).toEqual(["Renamed", "#112233"]);

    expect(await owner.flow.publish({ id: flowId })).toEqual({ success: true });
    expect((await as(null).community.get({ id: flowId })).name).toBe("Renamed");

    expect(await owner.flow.unpublish({ id: flowId })).toEqual({ success: true });
    await expect(as(null).community.get({ id: flowId })).rejects.toThrow("Flow not found");

    const deleted = await owner.flow.delete({ id: flowId });
    expect(deleted.id).toBe(flowId);
    await expect(owner.flow.get({ id: flowId })).rejects.toThrow("Flow not found");
    // Their access went with the flow.
    expect(await as(VIEWER).flow.list()).toEqual({ owned: [], collaborated: [] });
  });
});

describe("sharing", () => {
  test("changing and removing a collaborator takes effect on their next call", async () => {
    const owner = as(OWNER);

    await owner.flow.updateCollaboratorRole({ flowId, userId: VIEWER, role: "editor" });
    expect((await as(VIEWER).flow.get({ id: flowId })).role).toBe("editor");

    await owner.flow.removeCollaborator({ flowId, userId: VIEWER });
    await expect(as(VIEWER).flow.get({ id: flowId })).rejects.toThrow("Access denied");
  });

  test("updating the role of somebody who is not a collaborator does not add them", async () => {
    await expect(
      as(OWNER).flow.updateCollaboratorRole({ flowId, userId: STRANGER, role: "editor" }),
    ).rejects.toThrow("Collaborator not found");

    await expect(as(STRANGER).flow.get({ id: flowId })).rejects.toThrow("Access denied");
  });

  test("inviting an address with an account grants at once and tells them", async () => {
    const result = await as(OWNER).flow.addCollaboratorByEmail({
      flowId,
      email: `${STRANGER}@example.com`,
      role: "editor",
    });

    expect(result).toEqual({ success: true, userId: STRANGER });
    expect((await as(STRANGER).flow.get({ id: flowId })).role).toBe("editor");
    expect(sent).toMatchObject([
      { to: `${STRANGER}@example.com`, kind: "granted", role: "editor", flowName: "Blinky" },
    ]);
  });

  test("inviting an unknown address is pending until revoked", async () => {
    const owner = as(OWNER);

    const result = await owner.flow.addCollaboratorByEmail({
      flowId,
      email: "new@example.com",
      role: "viewer",
    });

    expect(result).toEqual({ success: true, invited: true });
    expect(sent).toMatchObject([{ to: "new@example.com", kind: "pending", invitedBy: OWNER }]);
    expect((await owner.flow.pendingInvites({ flowId })).map((i) => [i.email, i.role])).toEqual([
      ["new@example.com", "viewer"],
    ]);

    expect(await owner.flow.revokeInvite({ flowId, email: "new@example.com" })).toEqual({
      success: true,
    });
    expect(await owner.flow.pendingInvites({ flowId })).toEqual([]);
  });

  test("the Owner cannot invite themselves", async () => {
    await expect(
      as(OWNER).flow.addCollaboratorByEmail({ flowId, email: `${OWNER}@example.com` }),
    ).rejects.toThrow("Cannot add yourself as a collaborator");
  });

  test("user search finds other accounts by part of their email, never the caller", async () => {
    const found = await as(OWNER).flow.searchUsers({ query: "user-" });

    expect(found.map((u) => u.id).sort()).toEqual([EDITOR, STRANGER, VIEWER]);
  });
});

describe("creating", () => {
  test("anyone signed in creates and imports flows of their own", async () => {
    const created = await as(STRANGER).flow.create({ name: "Mine", color: "#fca5a5" });
    const imported = await as(STRANGER).flow.createFromImport({
      name: "Imported",
      nodes: [{ id: "a", type: "Note", position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });

    const { owned } = await as(STRANGER).flow.list();
    expect(owned.map((f) => [f.id, f.color, f.nodes.length]).sort()).toEqual(
      [
        [created!.id, "#fca5a5", 0],
        [imported!.id, "#4338ca", 1],
      ].sort(),
    );
  });

  test("the same content created twice is two flows; renaming one and deleting the other leaves the first whole", async () => {
    // What starting from a template twice sends: one name, one set of nodes and edges.
    const content = {
      name: "Blink",
      nodes: [
        { id: "interval-1", type: "Interval", position: { x: 0, y: 0 }, data: { interval: 500 } },
        { id: "led-1", type: "Led", position: { x: 440, y: 0 }, data: { pin: 13 } },
      ],
      edges: [
        { id: "e1", source: "interval-1", sourceHandle: "event", target: "led-1", targetHandle: "toggle" },
      ],
    };

    const first = await as(STRANGER).flow.createFromImport(content);
    const second = await as(STRANGER).flow.createFromImport(content);
    expect(second!.id).not.toBe(first!.id);

    const read = async (id: string) => {
      const { name, nodes, edges } = await as(STRANGER).flow.get({ id });
      return { name, nodes: nodes.map((n) => [n.id, n.data]), edges: edges.map((e) => e.id) };
    };
    const asCreated = {
      name: "Blink",
      nodes: content.nodes.map((n) => [n.id, n.data]),
      edges: ["e1"],
    };
    expect(await read(first!.id)).toEqual(asCreated);
    expect(await read(second!.id)).toEqual(asCreated);

    await as(STRANGER).flow.update({ id: first!.id, name: "Blink, mine" });
    await as(STRANGER).flow.delete({ id: second!.id });

    expect(await read(first!.id)).toEqual({ ...asCreated, name: "Blink, mine" });
    expect((await as(STRANGER).flow.list()).owned.map((f) => f.id)).toEqual([first!.id]);
  });

  test("a name or colour that does not fit is rejected before anything is written", async () => {
    await expect(as(STRANGER).flow.create({ name: "" })).rejects.toThrow();
    await expect(as(STRANGER).flow.create({ name: "x".repeat(101) })).rejects.toThrow();
    await expect(as(STRANGER).flow.create({ name: "Ok", color: "red" })).rejects.toThrow();

    expect((await as(STRANGER).flow.list()).owned).toEqual([]);
  });
});

describe("without a session", () => {
  test("every flow procedure, and bookmarking and forking, need one", async () => {
    const anonymous = as(null);
    await as(OWNER).flow.publish({ id: flowId });

    for (const call of [
      () => anonymous.flow.list(),
      () => anonymous.flow.get({ id: flowId }),
      () => anonymous.flow.create({ name: "Nope" }),
      () => anonymous.flow.delete({ id: flowId }),
      () => anonymous.community.bookmarks({}),
      () => anonymous.community.toggleBookmark({ flowId }),
      () => anonymous.community.fork({ id: flowId }),
    ]) {
      await expect(call()).rejects.toThrow("Authentication required");
    }
  });

  test("the Community is public: browse, open a flow, and a maker's profile", async () => {
    const anonymous = as(null);
    await as(OWNER).flow.publish({ id: flowId });

    expect((await anonymous.community.list({})).items.map((card) => card.id)).toEqual([flowId]);
    expect((await anonymous.community.get({ id: flowId })).author.id).toBe(OWNER);
    const profile = await anonymous.community.byAuthor({ userId: OWNER });
    expect([profile.total, profile.author.name]).toEqual([1, OWNER]);
    await expect(anonymous.community.byAuthor({ userId: "nobody" })).rejects.toThrow(
      "User not found",
    );
  });
});

describe("a refusal on the wire", () => {
  // The web app shows `error.message`; the code says what kind of "no" it was.
  test("carries the module's message and a code that fits it", async () => {
    const owner = as(OWNER);
    const refusals: Array<[() => Promise<unknown>, string, string]> = [
      [() => as(STRANGER).flow.get({ id: flowId }), "FORBIDDEN", "Access denied"],
      [
        () => as(VIEWER).flow.update({ id: flowId, name: "Mine now" }),
        "FORBIDDEN",
        "Access denied",
      ],
      [() => owner.flow.get({ id: "no-such-flow" }), "NOT_FOUND", "Flow not found"],
      [() => as(null).community.get({ id: flowId }), "NOT_FOUND", "Flow not found"],
      [() => as(VIEWER).community.fork({ id: flowId }), "NOT_FOUND", "Flow not found"],
      [() => as(null).community.byAuthor({ userId: "nobody" }), "NOT_FOUND", "User not found"],
      [
        () => owner.flow.updateCollaboratorRole({ flowId, userId: STRANGER, role: "editor" }),
        "NOT_FOUND",
        "Collaborator not found",
      ],
      [
        () => owner.flow.addCollaboratorByEmail({ flowId, email: `${OWNER}@example.com` }),
        "BAD_REQUEST",
        "Cannot add yourself as a collaborator",
      ],
      [() => as(null).flow.list(), "UNAUTHORIZED", "Authentication required"],
    ];

    for (const [call, code, message] of refusals) {
      await expect(call()).rejects.toMatchObject({ code, message });
    }
  });

  test("a failure that is nobody's decision stays an internal error", async () => {
    const db = await useTestDb();
    await db.execute(sql`ALTER TABLE flow_bookmark RENAME TO flow_bookmark_away`);
    try {
      await expect(as(null).community.list({})).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
    } finally {
      await db.execute(sql`ALTER TABLE flow_bookmark_away RENAME TO flow_bookmark`);
    }
  });
});

describe("the Community, signed in", () => {
  test("a Viewer of the flow bookmarks and forks it like anybody else", async () => {
    await as(OWNER).flow.publish({ id: flowId });
    const viewer = as(VIEWER);

    expect(await viewer.community.toggleBookmark({ flowId })).toEqual({ bookmarked: true });
    expect((await viewer.community.bookmarks({})).items.map((card) => card.id)).toEqual([flowId]);

    const fork = await viewer.community.fork({ id: flowId });
    expect(fork!.name).toBe("Blinky (copy)");
    // The fork is theirs: they own it, whatever their role on the source.
    expect((await viewer.flow.get({ id: fork!.id })).role).toBe("owner");

    const card = await as(null).community.get({ id: flowId });
    expect([card.bookmarkCount, card.forkCount]).toEqual([1, 1]);
  });
});
