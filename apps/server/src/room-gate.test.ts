import { describe, expect, test } from "bun:test";
import { classifyClose } from "@microflow/collab/protocol";
import { decideRoomAccess, type RoomGateDeps } from "./room-gate";

class Denied extends Error {
  constructor(readonly kind: "not-found" | "denied") {
    super(kind);
  }
}

function deps(overrides: Partial<RoomGateDeps>): RoomGateDeps {
  return {
    getSession: async () => ({ user: { id: "u1" } }),
    requireAccess: async () => ({ role: "editor" }),
    classifyDenial: (error) => (error instanceof Denied ? error.kind : null),
    ...overrides,
  };
}

/** The verdict a client reaches for the gate's close. */
async function verdict(overrides: Partial<RoomGateDeps>) {
  const decision = await decideRoomAccess(deps(overrides));
  if (decision.ok) throw new Error("expected a refusal");
  return { code: decision.code, verdict: classifyClose(decision.code) };
}

describe("websocket room gate", () => {
  test("an editor is admitted with write, a viewer read-only", async () => {
    expect(await decideRoomAccess(deps({}))).toEqual({ ok: true, userId: "u1", canWrite: true });
    expect(await decideRoomAccess(deps({ requireAccess: async () => ({ role: "viewer" }) }))).toEqual(
      { ok: true, userId: "u1", canWrite: false },
    );
  });

  test("a real denial is terminal", async () => {
    const result = await verdict({
      requireAccess: async () => {
        throw new Denied("denied");
      },
    });
    expect(result).toEqual({ code: 4403, verdict: "terminal" });
  });

  test("a missing flow is terminal, as flow-gone", async () => {
    const result = await verdict({
      requireAccess: async () => {
        throw new Denied("not-found");
      },
    });
    expect(result).toEqual({ code: 4404, verdict: "terminal" });
  });

  test("a database failure while checking access is retryable, not access-lost", async () => {
    const result = await verdict({
      requireAccess: async () => {
        throw new Error("connect ETIMEDOUT");
      },
    });
    expect(result).toEqual({ code: 1011, verdict: "retry" });
  });

  test("a failing session lookup is retryable too", async () => {
    const result = await verdict({
      getSession: async () => {
        throw new Error("pool not ready");
      },
    });
    expect(result).toEqual({ code: 1011, verdict: "retry" });
  });

  test("no session is the bounded re-auth case", async () => {
    expect(await verdict({ getSession: async () => null })).toEqual({ code: 1008, verdict: "reauth" });
  });
});
