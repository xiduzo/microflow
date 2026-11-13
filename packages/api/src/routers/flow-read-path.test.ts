import { beforeEach, describe, expect, mock, test } from "bun:test";
import { FlowDocument } from "@microflow/collab/schema";

/**
 * The flow router's read paths must not serve the debounced `flow.ydoc` row
 * while a room is live: `flow.get` and `flow.publish` take the room's
 * current state when there is one. The drizzle handle and the yjs server
 * singleton are replaced with stand-ins; only the call shapes used are
 * modelled.
 */

const OWNER = "user-owner";

function docWith(nodeId: string): Buffer {
  const doc = FlowDocument.createEmpty();
  doc.setFlowData([{ id: nodeId, type: "Note", position: { x: 0, y: 0 }, data: {} }], []);
  const bytes = Buffer.from(doc.encode());
  doc.destroy();
  return bytes;
}

const state = {
  stored: docWith("stored-node"),
  live: null as Uint8Array | null,
  updates: [] as Array<Record<string, unknown>>,
};

const flowRow = () => ({
  id: "flow-1",
  name: "Flow",
  color: null,
  ownerId: OWNER,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ydoc: state.stored,
  owner: { id: OWNER, name: "Owner", email: "o@example.com", image: null },
  collaborators: [],
});

mock.module("@microflow/db", () => ({
  db: {
    query: {
      flow: { findFirst: async () => flowRow(), findMany: async () => [flowRow()] },
      flowCollaborator: { findFirst: async () => undefined, findMany: async () => [] },
      userSettings: { findMany: async () => [] },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.updates.push(values);
        },
      }),
    }),
  },
}));

mock.module("@microflow/collab/server", () => ({
  FlowDocument,
  yjsServer: {
    currentState: () => state.live,
    setAccess: () => {},
    dropRoom: () => {},
  },
}));

// The mailer reaches env + email config at import; nothing here sends mail.
mock.module("./invite-mailer", () => ({ resendInviteMailer: async () => {} }));

const { flowRouter } = await import("./flow");

const caller = flowRouter.createCaller({
  session: { user: { id: OWNER } },
} as never);

function nodeIdsOf(ydoc: Buffer | null | undefined): string[] {
  if (!ydoc) return [];
  return FlowDocument.decode(new Uint8Array(ydoc))
    .getNodes()
    .map((n) => n.id);
}

beforeEach(() => {
  state.live = null;
  state.updates = [];
});

describe("flow.get", () => {
  test("serves the live room's document ahead of the stored row", async () => {
    state.live = docWith("live-node");

    const result = await caller.get({ id: "flow-1" });

    expect(result.nodes.map((n) => n.id)).toEqual(["live-node"]);
    expect(nodeIdsOf(Buffer.from(result.ydocBase64!, "base64"))).toEqual(["live-node"]);
  });

  test("falls back to the stored row when no room is live", async () => {
    const result = await caller.get({ id: "flow-1" });

    expect(result.nodes.map((n) => n.id)).toEqual(["stored-node"]);
  });
});

describe("flow.list", () => {
  test("previews the live room's document ahead of the stored row", async () => {
    state.live = docWith("live-node");

    const { owned } = await caller.list();

    expect(owned.map((f) => f.nodes.map((n) => n.id))).toEqual([["live-node"]]);
  });

  test("falls back to the stored row when no room is live", async () => {
    const { owned } = await caller.list();

    expect(owned.map((f) => f.nodes.map((n) => n.id))).toEqual([["stored-node"]]);
  });
});

describe("flow.publish", () => {
  test("snapshots the live room, not the debounced row", async () => {
    state.live = docWith("live-node");

    await caller.publish({ id: "flow-1" });

    expect(state.updates.length).toBe(1);
    expect(nodeIdsOf(state.updates[0]!.publishedYdoc as Buffer)).toEqual(["live-node"]);
  });
});
