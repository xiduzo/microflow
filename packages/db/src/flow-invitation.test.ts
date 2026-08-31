import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * A recording stand-in for the drizzle handle. Only the four call shapes the
 * invitation module uses are modelled; anything else throws loudly rather
 * than silently returning undefined.
 */
type Insert = { table: string; values: Record<string, unknown>; upsert: boolean };

const recorded = {
  inserts: [] as Insert[],
  deletes: [] as string[],
  users: [] as Array<{ id: string; email: string }>,
  invites: [] as Array<{ flowId: string; email: string; role: "viewer" | "editor" }>,
};

function reset() {
  recorded.inserts = [];
  recorded.deletes = [];
  recorded.users = [];
  recorded.invites = [];
}

/** drizzle tables carry their name on a well-known symbol; read it loosely. */
function tableName(table: unknown): string {
  const symbol = Object.getOwnPropertySymbols(table as object).find((s) =>
    s.toString().includes("Name"),
  );
  return symbol ? String((table as Record<symbol, unknown>)[symbol]) : "unknown";
}

mock.module("@microflow/db", () => ({
  db: {
    query: {
      user: {
        findFirst: async () => recorded.users[0] ?? undefined,
      },
      flowInvite: {
        findMany: async () => recorded.invites,
      },
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const insert: Insert = { table: tableName(table), values, upsert: false };
        recorded.inserts.push(insert);
        const thenable = {
          onConflictDoUpdate: async () => {
            insert.upsert = true;
          },
          then: (resolve: () => void) => resolve(),
        };
        return thenable;
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        recorded.deletes.push(tableName(table));
      },
    }),
  },
}));

const { acceptInvites, grantAccess, inviteByEmail } = await import("./flow-invitation");

const mailer = () => {
  const sent: unknown[] = [];
  return { sent, fn: async (notice: unknown) => void sent.push(notice) };
};

describe("grantAccess", () => {
  beforeEach(reset);

  test("upserts rather than inserting a second row", async () => {
    await grantAccess("flow-1", "user-1", "editor");

    expect(recorded.inserts.length).toBe(1);
    expect(recorded.inserts[0]!.table).toBe("flow_collaborator");
    expect(recorded.inserts[0]!.upsert).toBe(true);
    expect(recorded.inserts[0]!.values).toMatchObject({
      flowId: "flow-1",
      userId: "user-1",
      role: "editor",
    });
  });
});

describe("inviteByEmail", () => {
  beforeEach(reset);

  test("an address with an account is granted immediately", async () => {
    recorded.users = [{ id: "user-2", email: "her@example.com" }];
    const m = mailer();

    const result = await inviteByEmail({
      flowId: "flow-1",
      flowName: "Blinky",
      email: "her@example.com",
      role: "editor",
      invitedBy: { id: "owner-1", name: "Sander" },
      mailer: m.fn,
    });

    expect(result).toEqual({ kind: "granted", userId: "user-2" });
    expect(recorded.inserts[0]!.table).toBe("flow_collaborator");
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

    const result = await inviteByEmail({
      flowId: "flow-1",
      flowName: "Blinky",
      email: "stranger@example.com",
      role: "viewer",
      invitedBy: { id: "owner-1", name: "Sander" },
      mailer: m.fn,
    });

    expect(result).toEqual({ kind: "pending" });
    expect(recorded.inserts[0]!.table).toBe("flow_invite");
    expect(recorded.inserts[0]!.upsert).toBe(true); // re-inviting updates the role
    expect(m.sent[0]).toMatchObject({ kind: "pending", role: "viewer" });
  });

  test("inviting yourself is refused", async () => {
    recorded.users = [{ id: "owner-1", email: "me@example.com" }];
    const m = mailer();

    await expect(
      inviteByEmail({
        flowId: "flow-1",
        flowName: "Blinky",
        email: "me@example.com",
        role: "editor",
        invitedBy: { id: "owner-1", name: "Sander" },
        mailer: m.fn,
      }),
    ).rejects.toThrow("Cannot add yourself as a collaborator");

    expect(recorded.inserts.length).toBe(0);
    expect(m.sent.length).toBe(0);
  });

  test("a failing mailer does not undo the grant", async () => {
    recorded.users = [{ id: "user-2", email: "her@example.com" }];

    const result = await inviteByEmail({
      flowId: "flow-1",
      flowName: "Blinky",
      email: "her@example.com",
      role: "viewer",
      invitedBy: { id: "owner-1", name: "Sander" },
      mailer: async () => {
        throw new Error("resend is down");
      },
    });

    expect(result).toEqual({ kind: "granted", userId: "user-2" });
    expect(recorded.inserts[0]!.table).toBe("flow_collaborator");
  });
});

describe("acceptInvites", () => {
  beforeEach(reset);

  test("every pending invite becomes a grant, then the invites are cleared", async () => {
    recorded.invites = [
      { flowId: "flow-1", email: "new@example.com", role: "editor" },
      { flowId: "flow-2", email: "new@example.com", role: "viewer" },
    ];

    const granted = await acceptInvites("new@example.com", "user-9");

    expect(granted).toEqual(["flow-1", "flow-2"]);
    expect(recorded.inserts.map((i) => i.values.role)).toEqual(["editor", "viewer"]);
    expect(recorded.inserts.every((i) => i.values.userId === "user-9")).toBe(true);
    // Upsert, so a user already holding one of these flows is not duplicated.
    expect(recorded.inserts.every((i) => i.upsert)).toBe(true);
    expect(recorded.deletes).toEqual(["flow_invite"]);
  });

  test("no invites means no writes at all", async () => {
    const granted = await acceptInvites("nobody@example.com", "user-9");

    expect(granted).toEqual([]);
    expect(recorded.inserts.length).toBe(0);
    expect(recorded.deletes.length).toBe(0);
  });
});
