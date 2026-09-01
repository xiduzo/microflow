import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Recording stand-ins for setFlowRole's two dependencies: the drizzle handle
 * (the row write) and the yjs server singleton (the live push). Only the call
 * shapes flow-access + flow-invitation use are modelled.
 */
type Insert = { table: string; values: Record<string, unknown>; upsert: boolean };

const recorded = {
  inserts: [] as Insert[],
  deletes: [] as string[],
  pushes: [] as Array<{ flowId: string; userId: string; access: string }>,
  users: [] as Array<{ id: string; email: string }>,
};

function reset() {
  recorded.inserts = [];
  recorded.deletes = [];
  recorded.pushes = [];
  recorded.users = [];
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
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const insert: Insert = { table: tableName(table), values, upsert: false };
        recorded.inserts.push(insert);
        return {
          onConflictDoUpdate: async () => {
            insert.upsert = true;
          },
          then: (resolve: () => void) => resolve(),
        };
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        recorded.deletes.push(tableName(table));
      },
    }),
  },
}));

mock.module("@microflow/collab/server", () => ({
  yjsServer: {
    setAccess: (flowId: string, userId: string, access: string) => {
      recorded.pushes.push({ flowId, userId, access });
    },
  },
}));

const { assertFlowRole, resolveFlowRole, roleToAccess, setFlowRole } =
  await import("./flow-access");
type FlowRole = import("./flow-access").FlowRole;
const { inviteByEmail } = await import("@microflow/db/flow-invitation");

const OWNER = "user-owner";
const OTHER = "user-other";
const flowRecord = { ownerId: OWNER };

describe("resolveFlowRole", () => {
  test("owner wins regardless of collaborator role", () => {
    expect(resolveFlowRole(flowRecord, OWNER, undefined)).toBe("owner");
    expect(resolveFlowRole(flowRecord, OWNER, "viewer")).toBe("owner");
  });

  test("non-owner gets their collaborator role, or null", () => {
    expect(resolveFlowRole(flowRecord, OTHER, "editor")).toBe("editor");
    expect(resolveFlowRole(flowRecord, OTHER, "viewer")).toBe("viewer");
    expect(resolveFlowRole(flowRecord, OTHER, undefined)).toBeNull();
    expect(resolveFlowRole(flowRecord, OTHER, null)).toBeNull();
  });
});

describe("assertFlowRole access matrix", () => {
  const cases: Array<[FlowRole | null, FlowRole, boolean]> = [
    // [actual role, required role, allowed]
    ["owner", "owner", true],
    ["owner", "editor", true],
    ["owner", "viewer", true],
    ["editor", "owner", false],
    ["editor", "editor", true],
    ["editor", "viewer", true],
    ["viewer", "owner", false],
    ["viewer", "editor", false],
    ["viewer", "viewer", true],
    [null, "viewer", false],
    [null, "editor", false],
    [null, "owner", false],
  ];

  test.each(cases)("role=%p minRole=%p → allowed=%p", (role, minRole, allowed) => {
    if (allowed) {
      expect(assertFlowRole(role, minRole)).toBe(role as FlowRole);
    } else {
      expect(() => assertFlowRole(role, minRole)).toThrow("Access denied");
    }
  });
});

describe("roleToAccess", () => {
  const cases: Array<["viewer" | "editor" | null, "none" | "read" | "write"]> = [
    [null, "none"],
    ["viewer", "read"],
    ["editor", "write"],
  ];

  test.each(cases)("role=%p → access=%p", (role, access) => {
    expect(roleToAccess(role)).toBe(access);
  });
});

describe("setFlowRole", () => {
  beforeEach(reset);

  test("granting a role writes the row AND pushes live access", async () => {
    await setFlowRole("flow-1", "user-2", "editor");

    expect(recorded.inserts.length).toBe(1);
    expect(recorded.inserts[0]!.table).toBe("flow_collaborator");
    expect(recorded.inserts[0]!.upsert).toBe(true);
    expect(recorded.inserts[0]!.values).toMatchObject({
      flowId: "flow-1",
      userId: "user-2",
      role: "editor",
    });
    expect(recorded.pushes).toEqual([
      { flowId: "flow-1", userId: "user-2", access: "write" },
    ]);
  });

  test("changing to viewer pushes read access", async () => {
    await setFlowRole("flow-1", "user-2", "viewer");

    expect(recorded.inserts[0]!.values).toMatchObject({ role: "viewer" });
    expect(recorded.pushes).toEqual([
      { flowId: "flow-1", userId: "user-2", access: "read" },
    ]);
  });

  test("revoking deletes the row AND pushes none", async () => {
    await setFlowRole("flow-1", "user-2", null);

    expect(recorded.inserts.length).toBe(0);
    expect(recorded.deletes).toEqual(["flow_collaborator"]);
    expect(recorded.pushes).toEqual([
      { flowId: "flow-1", userId: "user-2", access: "none" },
    ]);
  });

  // Regression: the invitation-accept path used to write the row without the
  // live push, so a collaborator whose role changed via re-invite kept their
  // old room access until reconnect.
  test("inviteByEmail granted through setFlowRole pushes live access too", async () => {
    recorded.users = [{ id: "user-2", email: "her@example.com" }];

    const result = await inviteByEmail({
      flowId: "flow-1",
      flowName: "Blinky",
      email: "her@example.com",
      role: "viewer",
      invitedBy: { id: OWNER, name: "Sander" },
      grant: setFlowRole,
      mailer: async () => {},
    });

    expect(result).toEqual({ kind: "granted", userId: "user-2" });
    expect(recorded.inserts[0]!.table).toBe("flow_collaborator");
    expect(recorded.pushes).toEqual([
      { flowId: "flow-1", userId: "user-2", access: "read" },
    ]);
  });
});
