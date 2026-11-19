import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import {
  acceptInvites,
  grantAccess,
  inviteByEmail,
  listPendingInvites,
  revokeInvite,
  type CollaboratorRole,
  type InviteNotice,
} from "./flow-invitation";
import type { Db } from "./index";
import { flow, flowCollaborator } from "./schema/flow";
import { user } from "./schema/auth";
import { useTestDb } from "./testing";

/**
 * Flow Invitation against the in-process Postgres: the real schema, the real
 * unique indexes. Assertions read rows back, never the calls that wrote them.
 */

const OWNER = "owner-1";
let db: Db;

async function addUser(id: string, email = `${id}@example.com`) {
  await db.insert(user).values({ id, name: id, email });
}

async function addFlow(id: string, ownerId = OWNER) {
  await db.insert(flow).values({ id, name: id, ownerId });
}

/** Who holds what on which flow, in a stable order. */
async function grants() {
  const rows = await db.select().from(flowCollaborator);
  return rows
    .map((row) => `${row.flowId}:${row.userId}:${row.role}`)
    .sort();
}

async function pendingFor(flowId: string) {
  const invites = await listPendingInvites(flowId);
  return invites.map((invite) => `${invite.email}:${invite.role}`).sort();
}

const mailer = () => {
  const sent: InviteNotice[] = [];
  return { sent, fn: async (notice: InviteNotice) => void sent.push(notice) };
};

/** Recording stand-in for the injected grant (the api layer's setFlowRole). */
const granter = () => {
  const calls: Array<{ flowId: string; userId: string; role: CollaboratorRole }> = [];
  return {
    calls,
    fn: async (flowId: string, userId: string, role: CollaboratorRole) =>
      void calls.push({ flowId, userId, role }),
  };
};

const invite = (
  email: string,
  role: CollaboratorRole,
  overrides: Partial<Parameters<typeof inviteByEmail>[0]> = {},
) =>
  inviteByEmail({
    flowId: "flow-1",
    flowName: "Blinky",
    email,
    role,
    invitedBy: { id: OWNER, name: "Sander" },
    grant: async () => {},
    mailer: async () => {},
    ...overrides,
  });

beforeEach(async () => {
  db = await useTestDb();
  await addUser(OWNER, "me@example.com");
  await addFlow("flow-1");
  await addFlow("flow-2");
});

describe("grantAccess", () => {
  test("a second grant leaves one row, with the later role", async () => {
    await addUser("user-1");

    await grantAccess("flow-1", "user-1", "viewer");
    await grantAccess("flow-1", "user-1", "editor");

    expect(await grants()).toEqual(["flow-1:user-1:editor"]);
  });

  test("grants on different flows do not collide", async () => {
    await addUser("user-1");

    await grantAccess("flow-1", "user-1", "viewer");
    await grantAccess("flow-2", "user-1", "editor");

    expect(await grants()).toEqual(["flow-1:user-1:viewer", "flow-2:user-1:editor"]);
  });
});

describe("inviteByEmail", () => {
  test("an address with an account is granted through the injected grant", async () => {
    await addUser("user-2", "her@example.com");
    const m = mailer();
    const g = granter();

    const result = await invite("her@example.com", "editor", { grant: g.fn, mailer: m.fn });

    expect(result).toEqual({ kind: "granted", userId: "user-2" });
    // The grant goes through the adapter — pairing row write + live push is
    // the caller's setFlowRole's job, not a direct row write from here.
    expect(g.calls).toEqual([{ flowId: "flow-1", userId: "user-2", role: "editor" }]);
    expect(await grants()).toEqual([]);
    expect(await pendingFor("flow-1")).toEqual([]);
    expect(m.sent[0]).toMatchObject({
      to: "her@example.com",
      kind: "granted",
      role: "editor",
      flowName: "Blinky",
      invitedBy: "Sander",
    });
  });

  test("an address with no account becomes a pending invite", async () => {
    const m = mailer();
    const g = granter();

    const result = await invite("stranger@example.com", "viewer", { grant: g.fn, mailer: m.fn });

    expect(result).toEqual({ kind: "pending" });
    expect(g.calls.length).toBe(0);
    expect(await pendingFor("flow-1")).toEqual(["stranger@example.com:viewer"]);
    expect(m.sent[0]).toMatchObject({ kind: "pending", role: "viewer" });
  });

  test("re-inviting an address updates the pending invite instead of adding one", async () => {
    await invite("stranger@example.com", "viewer");
    await invite("stranger@example.com", "editor");

    expect(await pendingFor("flow-1")).toEqual(["stranger@example.com:editor"]);
  });

  test("inviting yourself is refused", async () => {
    const m = mailer();
    const g = granter();

    await expect(
      invite("me@example.com", "editor", { grant: g.fn, mailer: m.fn }),
    ).rejects.toThrow("Cannot add yourself as a collaborator");

    expect(g.calls.length).toBe(0);
    expect(await pendingFor("flow-1")).toEqual([]);
    expect(m.sent.length).toBe(0);
  });

  test("a failing mailer does not undo the grant", async () => {
    await addUser("user-2", "her@example.com");
    const g = granter();

    const result = await invite("her@example.com", "viewer", {
      grant: g.fn,
      mailer: async () => {
        throw new Error("resend is down");
      },
    });

    expect(result).toEqual({ kind: "granted", userId: "user-2" });
    expect(g.calls).toEqual([{ flowId: "flow-1", userId: "user-2", role: "viewer" }]);
  });

  test("a failing mailer does not undo a pending invite", async () => {
    await invite("stranger@example.com", "editor", {
      mailer: async () => {
        throw new Error("resend is down");
      },
    });

    expect(await pendingFor("flow-1")).toEqual(["stranger@example.com:editor"]);
  });
});

describe("acceptInvites", () => {
  test("every pending invite becomes a grant, then the invites are cleared", async () => {
    await invite("new@example.com", "editor");
    await invite("new@example.com", "viewer", { flowId: "flow-2" });
    await invite("other@example.com", "viewer");
    await addUser("user-9", "new@example.com");

    const granted = await acceptInvites("new@example.com", "user-9");

    expect(granted.sort()).toEqual(["flow-1", "flow-2"]);
    expect(await grants()).toEqual(["flow-1:user-9:editor", "flow-2:user-9:viewer"]);
    // Somebody else's invite on the same flow is untouched.
    expect(await pendingFor("flow-1")).toEqual(["other@example.com:viewer"]);
    expect(await pendingFor("flow-2")).toEqual([]);
  });

  test("an invite for a flow the user already holds updates that grant", async () => {
    await invite("new@example.com", "editor");
    await addUser("user-9", "new@example.com");
    await grantAccess("flow-1", "user-9", "viewer");

    await acceptInvites("new@example.com", "user-9");

    expect(await grants()).toEqual(["flow-1:user-9:editor"]);
  });

  test("a revoked invite grants nothing", async () => {
    await invite("new@example.com", "editor");
    await invite("new@example.com", "viewer", { flowId: "flow-2" });
    await revokeInvite("flow-1", "new@example.com");
    await addUser("user-9", "new@example.com");

    const granted = await acceptInvites("new@example.com", "user-9");

    expect(granted).toEqual(["flow-2"]);
    expect(await grants()).toEqual(["flow-2:user-9:viewer"]);
  });

  test("accepting twice grants once", async () => {
    await invite("new@example.com", "editor");
    await addUser("user-9", "new@example.com");

    await acceptInvites("new@example.com", "user-9");
    const second = await acceptInvites("new@example.com", "user-9");

    expect(second).toEqual([]);
    expect(await grants()).toEqual(["flow-1:user-9:editor"]);
  });

  test("no invites means no grants", async () => {
    await addUser("user-9", "nobody@example.com");

    const granted = await acceptInvites("nobody@example.com", "user-9");

    expect(granted).toEqual([]);
    expect(await grants()).toEqual([]);
  });

  // The sign-up hook runs once per account, so an accept that fails part-way
  // is never finished by a retry: what it leaves behind is what stays.
  test("a failure part-way leaves every invite pending and grants nothing", async () => {
    await invite("new@example.com", "editor");
    await invite("new@example.com", "viewer", { flowId: "flow-2" });
    await addUser("user-9", "new@example.com");
    // Make the grant on flow-2 fail, as a database error would.
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION refuse_flow_2() RETURNS trigger AS $$
      BEGIN
        IF NEW.flow_id = 'flow-2' THEN RAISE EXCEPTION 'grant refused'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      CREATE TRIGGER refuse_flow_2 BEFORE INSERT ON flow_collaborator
      FOR EACH ROW EXECUTE FUNCTION refuse_flow_2()
    `);

    await expect(acceptInvites("new@example.com", "user-9")).rejects.toThrow();

    expect(await grants()).toEqual([]);
    expect(await pendingFor("flow-1")).toEqual(["new@example.com:editor"]);
    expect(await pendingFor("flow-2")).toEqual(["new@example.com:viewer"]);
  });
});

describe("revokeInvite", () => {
  test("withdraws one invite and leaves the others", async () => {
    await invite("a@example.com", "viewer");
    await invite("b@example.com", "editor");

    await revokeInvite("flow-1", "a@example.com");

    expect(await pendingFor("flow-1")).toEqual(["b@example.com:editor"]);
  });

  test("is a no-op for an invite that is not there", async () => {
    await revokeInvite("flow-1", "ghost@example.com");

    expect(await pendingFor("flow-1")).toEqual([]);
  });
});

describe("listPendingInvites", () => {
  test("a deleted flow takes its invites with it", async () => {
    await invite("a@example.com", "viewer");

    await db.delete(flow);

    expect(await pendingFor("flow-1")).toEqual([]);
  });
});
