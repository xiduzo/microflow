import { beforeEach, describe, expect, mock, test } from "bun:test";
import { FlowDocument } from "@microflow/collab/schema";

/**
 * A rename is two writes: the flow row (lists, search) and the document's
 * `meta.name` (export and sketch filenames). `flow.update` must make both;
 * whether the document write lands in a live room or the store is
 * `YjsServer.writeMeta`'s concern, tested in the collab package.
 */

const OWNER = "user-owner";

const recorded = {
  rowWrites: [] as Array<Record<string, unknown>>,
  metaWrites: [] as Array<{ flowId: string; meta: Record<string, unknown> }>,
};

mock.module("@microflow/db", () => ({
  db: {
    query: {
      flow: { findFirst: async () => ({ id: "flow-1", ownerId: OWNER }) },
      flowCollaborator: { findFirst: async () => undefined },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            recorded.rowWrites.push(values);
            return [{ id: "flow-1", ...values }];
          },
        }),
      }),
    }),
  },
}));

mock.module("@microflow/collab/server", () => ({
  FlowDocument,
  yjsServer: {
    writeMeta: async (flowId: string, meta: Record<string, unknown>) => {
      // A name the store "cannot" take — every attempt fails, retries included.
      if (meta.name === "Doomed") throw new Error("store unavailable");
      recorded.metaWrites.push({ flowId, meta });
    },
    currentState: () => null,
    setAccess: () => {},
    dropRoom: () => {},
  },
}));

mock.module("./invite-mailer", () => ({ resendInviteMailer: async () => {} }));

const { flowRouter } = await import("./flow");
const { mirrorNameToDocument } = await import("./flow-rename");
const caller = flowRouter.createCaller({ session: { user: { id: OWNER } } } as never);

beforeEach(() => {
  recorded.rowWrites = [];
  recorded.metaWrites = [];
});

describe("flow.update", () => {
  test("a rename writes the row and the document's meta.name", async () => {
    await caller.update({ id: "flow-1", name: "Renamed" });

    expect(recorded.rowWrites[0]?.name).toBe("Renamed");
    expect(recorded.metaWrites).toEqual([{ flowId: "flow-1", meta: { name: "Renamed" } }]);
  });

  test("a colour-only update leaves the document alone", async () => {
    await caller.update({ id: "flow-1", color: "#112233" });

    expect(recorded.rowWrites.length).toBe(1);
    expect(recorded.metaWrites).toEqual([]);
  });

  test("a failed document write does not fail the rename the row already committed", async () => {
    const result = await caller.update({ id: "flow-1", name: "Doomed" });

    expect(recorded.rowWrites[0]?.name).toBe("Doomed");
    expect(result[0]?.name).toBe("Doomed");
  });
});

describe("mirrorNameToDocument", () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("a failed write is retried with backoff until it lands", async () => {
    let calls = 0;
    const write = async () => {
      if (++calls < 3) throw new Error("store unavailable");
    };
    await mirrorNameToDocument("flow-1", "Renamed", write, [5, 5, 5]);
    expect(calls).toBe(1); // the mutation waits for the first attempt only

    await tick(80);
    expect(calls).toBe(3); // two retries; the second landed, no more after it
  });

  test("it gives up after the last delay", async () => {
    let calls = 0;
    const write = async () => {
      calls++;
      throw new Error("store unavailable");
    };
    await mirrorNameToDocument("flow-1", "Renamed", write, [5, 5]);
    await tick(80);
    expect(calls).toBe(3);
  });
});
