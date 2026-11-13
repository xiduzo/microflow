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
      recorded.metaWrites.push({ flowId, meta });
    },
    currentState: () => null,
    setAccess: () => {},
    dropRoom: () => {},
  },
}));

mock.module("./invite-mailer", () => ({ resendInviteMailer: async () => {} }));

const { flowRouter } = await import("./flow");
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
});
