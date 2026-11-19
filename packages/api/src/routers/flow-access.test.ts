import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { Db } from "@microflow/db";
import { flow, flowCollaborator } from "@microflow/db/schema/flow";
import { user } from "@microflow/db/schema/auth";
import { inviteByEmail } from "@microflow/db/flow-invitation";
import { useTestDb } from "@microflow/db/testing";
import { CLOSE_ACCESS_DENIED, yjsServer } from "@microflow/collab/server";
import {
  assertFlowRole,
  FlowAccessDenied,
  requireFlowAccess,
  resolveFlowRole,
  roleToAccess,
  setFlowRole,
  type FlowRole,
} from "./flow-access";

/**
 * Flow Access: the pure role rules, then the query and the role transition
 * on the in-process Postgres with the real room server. A "live socket" below
 * is a connection that joined the flow's room, so the live half of a role
 * change is observed on it, not on a recorded call.
 */

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

  test("a denial is a FlowAccessDenied, so the websocket gate can tell it from a DB failure", () => {
    let caught: unknown;
    try {
      assertFlowRole(null, "viewer");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FlowAccessDenied);
    expect((caught as InstanceType<typeof FlowAccessDenied>).kind).toBe("denied");
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

// ============================================================================
// On real SQL
// ============================================================================

const FLOW = "flow-1";
let db: Db;

async function seed() {
  db = await useTestDb();
  await db.insert(user).values([
    { id: OWNER, name: "Owner", email: "owner@example.com" },
    { id: OTHER, name: "Other", email: "her@example.com" },
  ]);
  await db.insert(flow).values({ id: FLOW, name: "Blinky", ownerId: OWNER });
}

/** Who holds what on the flow, read back from the table. */
async function grants() {
  const rows = await db.select().from(flowCollaborator);
  return rows.map((row) => `${row.flowId}:${row.userId}:${row.role}`);
}

/** Attach a socket to the flow's room as `userId`, recording how it is closed. */
async function liveSocket(userId: string, canWrite: boolean) {
  const closes: Array<number | undefined> = [];
  const connection = await yjsServer.join(
    FLOW,
    { send: () => {}, close: (code?: number) => void closes.push(code) },
    userId,
    canWrite,
  );
  return { connection, closes };
}

describe("requireFlowAccess", () => {
  beforeEach(seed);

  test("the owner is an owner, and gets the flow row back", async () => {
    const { flow: found, role } = await requireFlowAccess(FLOW, OWNER, "owner");

    expect(role).toBe("owner");
    expect(found).toMatchObject({ id: FLOW, name: "Blinky", ownerId: OWNER });
  });

  test("a collaborator gets the role on their grant", async () => {
    await setFlowRole(FLOW, OTHER, "viewer");
    expect((await requireFlowAccess(FLOW, OTHER, "viewer")).role).toBe("viewer");

    await setFlowRole(FLOW, OTHER, "editor");
    expect((await requireFlowAccess(FLOW, OTHER, "viewer")).role).toBe("editor");
    expect((await requireFlowAccess(FLOW, OTHER, "editor")).role).toBe("editor");
  });

  test("a role below the minimum is denied", async () => {
    await setFlowRole(FLOW, OTHER, "viewer");

    await expect(requireFlowAccess(FLOW, OTHER, "editor")).rejects.toThrow("Access denied");
    await setFlowRole(FLOW, OTHER, "editor");
    await expect(requireFlowAccess(FLOW, OTHER, "owner")).rejects.toThrow("Access denied");
  });

  test("a user with no grant is denied, and a grant on another flow does not count", async () => {
    await db.insert(flow).values({ id: "flow-2", name: "Other flow", ownerId: OWNER });
    await setFlowRole("flow-2", OTHER, "editor");

    const denied = await requireFlowAccess(FLOW, OTHER, "viewer").catch((error) => error);

    expect(denied).toBeInstanceOf(FlowAccessDenied);
    expect(denied.kind).toBe("denied");
  });

  test("a revoked collaborator is denied again", async () => {
    await setFlowRole(FLOW, OTHER, "editor");
    await setFlowRole(FLOW, OTHER, null);

    await expect(requireFlowAccess(FLOW, OTHER, "viewer")).rejects.toThrow("Access denied");
  });

  test("a flow that does not exist is not found, whoever asks", async () => {
    const missing = await requireFlowAccess("no-such-flow", OWNER, "viewer").catch(
      (error) => error,
    );

    expect(missing).toBeInstanceOf(FlowAccessDenied);
    expect(missing.kind).toBe("not-found");
    expect(missing.message).toBe("Flow not found");
  });

  test("a database failure is not an access decision", async () => {
    // No such table: the query itself fails, as it would on a lost connection.
    await db.execute(sql`ALTER TABLE flow_collaborator RENAME TO flow_collaborator_away`);
    try {
      const failure = await requireFlowAccess(FLOW, OTHER, "viewer").catch((error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(FlowAccessDenied);
    } finally {
      await db.execute(sql`ALTER TABLE flow_collaborator_away RENAME TO flow_collaborator`);
    }
  });
});

describe("setFlowRole", () => {
  beforeEach(seed);

  test("granting twice leaves one row, with the later role", async () => {
    await setFlowRole(FLOW, OTHER, "viewer");
    await setFlowRole(FLOW, OTHER, "editor");

    expect(await grants()).toEqual([`${FLOW}:${OTHER}:editor`]);
  });

  test("promoting a viewer lets their live socket write", async () => {
    await setFlowRole(FLOW, OTHER, "viewer");
    const { connection } = await liveSocket(OTHER, false);

    await setFlowRole(FLOW, OTHER, "editor");

    expect(connection.canWrite).toBe(true);
    connection.close();
  });

  test("demoting an editor stops their live socket writing, without closing it", async () => {
    await setFlowRole(FLOW, OTHER, "editor");
    const { connection, closes } = await liveSocket(OTHER, true);

    await setFlowRole(FLOW, OTHER, "viewer");

    expect(connection.canWrite).toBe(false);
    expect(closes).toEqual([]);
    expect(await grants()).toEqual([`${FLOW}:${OTHER}:viewer`]);
    connection.close();
  });

  test("revoking deletes the grant and closes their live socket for good", async () => {
    await setFlowRole(FLOW, OTHER, "editor");
    const { closes } = await liveSocket(OTHER, true);
    const bystander = await liveSocket(OWNER, true);

    await setFlowRole(FLOW, OTHER, null);

    expect(await grants()).toEqual([]);
    expect(closes).toEqual([CLOSE_ACCESS_DENIED]);
    // Only the revoked user's sockets are touched.
    expect(bystander.closes).toEqual([]);
    expect(bystander.connection.canWrite).toBe(true);
    bystander.connection.close();
  });

  test("revoking somebody who holds nothing is a no-op", async () => {
    await setFlowRole(FLOW, OTHER, null);

    expect(await grants()).toEqual([]);
  });

  // Regression: the invitation grant path used to write the row without the
  // live push, so a collaborator whose role changed via re-invite kept their
  // old room access until reconnect.
  test("inviteByEmail granted through setFlowRole reaches the live socket too", async () => {
    await setFlowRole(FLOW, OTHER, "editor");
    const { connection } = await liveSocket(OTHER, true);

    const result = await inviteByEmail({
      flowId: FLOW,
      flowName: "Blinky",
      email: "her@example.com",
      role: "viewer",
      invitedBy: { id: OWNER, name: "Sander" },
      grant: setFlowRole,
      mailer: async () => {},
    });

    expect(result).toEqual({ kind: "granted", userId: OTHER });
    expect(await grants()).toEqual([`${FLOW}:${OTHER}:viewer`]);
    expect(connection.canWrite).toBe(false);
    connection.close();
  });
});
