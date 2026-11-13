import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { FlowDocument } from "@microflow/collab";
import { createCloudSession, makeSession } from "./flow-session";
import { constantSessionStatus } from "./session-status";
import type { SyncAdapter } from "./sync-adapter";

describe("createCloudSession", () => {
  test("a seed persisted before ADR-0019 is readable, and the client writes no upgrade into it", () => {
    // A server snapshot in the pre-ADR-0019 shape: nodes as plain objects.
    const legacy = new Y.Doc();
    legacy.getMap<unknown>("nodes").set("old", {
      id: "old",
      type: "Led",
      position: { x: 1, y: 2 },
      data: { pin: 13 },
    });

    const session = createCloudSession({
      flowId: "f1",
      // Never reached: the test reads the seeded doc and destroys the session.
      wsUrl: "ws://127.0.0.1:9",
      user: { id: "u1", name: "Tester" },
      initialData: Y.encodeStateAsUpdate(legacy),
    });
    try {
      const node = session.doc.getNode("old");
      expect(node?.type).toBe("Led");
      expect(node?.position).toEqual({ x: 1, y: 2 });
      expect(node?.data).toEqual({ pin: 13 });

      // The server owns the upgrade of a cloud room: the seed is left as it
      // was persisted, with nothing written by this client to race it.
      expect(session.doc.nodes.get("old")).not.toBeInstanceOf(Y.Map);
      const ownClock = Y.decodeStateVector(Y.encodeStateVector(session.doc.doc)).get(
        session.doc.doc.clientID,
      );
      expect(ownClock).toBeUndefined();
    } finally {
      session.destroy();
    }
  });
});

describe("dangling-edge pruning belongs to the session", () => {
  const noopSync: SyncAdapter = { kind: "local", destroy() {} };

  function seeded(): FlowDocument {
    const doc = FlowDocument.createEmpty();
    doc.addNode({ id: "a", type: "Counter", position: { x: 0, y: 0 }, data: {} });
    doc.addNode({ id: "b", type: "Counter", position: { x: 0, y: 0 }, data: {} });
    return doc;
  }
  /** A peer deletes `b` while another peer's edge to it arrives afterwards. */
  const lateEdgeToDeleted = (doc: FlowDocument) => {
    doc.doc.transact(() => doc.deleteNode("b"), "remote");
    doc.doc.transact(() => doc.addEdge({ id: "late", source: "a", target: "b" }), "remote");
  };

  /** A status store whose `readOnly` the test flips, like a live access change. */
  function liveStatus(readOnly: boolean) {
    let snapshot = { ...constantSessionStatus(readOnly).getSnapshot() };
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set(next: boolean) {
        snapshot = { ...snapshot, readOnly: next };
        for (const listener of listeners) listener();
      },
    };
  }

  test("an Editor session prunes with no canvas mounted", () => {
    const doc = seeded();
    const session = makeSession("local", "f", doc, noopSync, false);
    lateEdgeToDeleted(doc);
    expect(doc.hasEdge("late")).toBe(false);
    session.destroy();
  });

  test("a Viewer session never prunes", () => {
    const doc = seeded();
    const session = makeSession("cloud", "f", doc, noopSync, true, "viewer");
    lateEdgeToDeleted(doc);
    expect(doc.hasEdge("late")).toBe(true);
    session.destroy();
  });

  test("a read-only preview never prunes what it was seeded with", () => {
    const doc = seeded();
    lateEdgeToDeleted(doc);
    const session = makeSession("local", "__preview__", doc, noopSync, true);
    expect(doc.hasEdge("late")).toBe(true);
    session.destroy();
  });

  test("pruning follows live access: demotion stops it, promotion starts it", () => {
    const doc = seeded();
    const status = liveStatus(false);
    const session = makeSession("cloud", "f", doc, noopSync, false, "editor", status);

    status.set(true); // demoted to Viewer
    lateEdgeToDeleted(doc);
    expect(doc.hasEdge("late")).toBe(true);

    status.set(false); // promoted back: starting prunes what is there
    expect(doc.hasEdge("late")).toBe(false);
    session.destroy();
  });

  test("destroy stops pruning", () => {
    const doc = seeded();
    let stopped = 0;
    const start = doc.startEdgePruning.bind(doc);
    doc.startEdgePruning = () => {
      const stop = start();
      return () => {
        stopped += 1;
        stop();
      };
    };
    // destroy() also destroys the doc; keep it usable to observe the listener.
    doc.destroy = () => {};
    const session = makeSession("local", "f", doc, noopSync, false);
    session.destroy();
    expect(stopped).toBe(1);
    lateEdgeToDeleted(doc);
    expect(doc.hasEdge("late")).toBe(true);
  });
});
