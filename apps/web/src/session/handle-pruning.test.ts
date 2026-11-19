import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { FlowDocument, upgradeLegacyNodes, type FlowEdge, type FlowNode } from "@microflow/collab";
import { makeSession, provideHandleSets } from "./flow-session";
import type { HandleSets } from "./handle-pruning";
import { constantSessionStatus, type FlowSessionStatus } from "./session-status";
import type { SyncAdapter } from "./sync-adapter";

// The pruning trigger belongs to the session, so every test drives a session
// over an in-memory document and only ever edits the document: no canvas, no
// mounted node component, no provider.
//
// The session is handed what a node's handles are. Here that is a stand-in: a
// `Plug` node offers exactly the handles its data lists, and any other type is
// unknown. What real nodes offer is the node library's to test
// (`nodes/handle-pruning.test.ts` runs the real rules through a session).

const list = (value: unknown): string[] => (Array.isArray(value) ? value : []);
const plugHandles: HandleSets = (node) =>
  node.type === "Plug" ? { ports: list(node.data.ports), emits: list(node.data.emits) } : null;

beforeEach(() => provideHandleSets(plugHandles));
afterEach(() => provideHandleSets(null));

const noopSync: SyncAdapter = { kind: "local", destroy() {} };

const plug = (id: string, ports: string[], emits: string[] = []): FlowNode => ({
  id,
  type: "Plug",
  position: { x: 0, y: 0 },
  data: { ports, emits },
});

const edge = (
  id: string,
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): FlowEdge => ({ id, source, sourceHandle, target, targetHandle });

function seeded(nodes: FlowNode[], edges: FlowEdge[]): FlowDocument {
  const doc = FlowDocument.createEmpty();
  doc.doc.transact(() => {
    for (const n of nodes) doc.addNode(n);
    for (const e of edges) doc.addEdge(e);
  }, "seed");
  return doc;
}

/** A status store that reports `kind`, like a cloud session in that state. */
function statusOf(kind: FlowSessionStatus["kind"]) {
  let snapshot: FlowSessionStatus = { ...constantSessionStatus(false).getSnapshot(), kind };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: FlowSessionStatus["kind"]) {
      snapshot = { ...snapshot, kind: next };
      for (const listener of listeners) listener();
    },
  };
}

/** What a peer or a store holds after `edit`, as the update that brings `doc` there. */
function updateFrom(doc: FlowDocument, edit: (copy: FlowDocument) => void): Uint8Array {
  const copy = new FlowDocument();
  Y.applyUpdate(copy.doc, Y.encodeStateAsUpdate(doc.doc));
  edit(copy);
  return Y.encodeStateAsUpdate(copy.doc, Y.encodeStateVector(doc.doc));
}

/** A peer makes `edit` and it arrives here, the way a provider delivers it. */
function fromPeer(doc: FlowDocument, edit: (copy: FlowDocument) => void): void {
  Y.applyUpdate(doc.doc, updateFrom(doc, edit), "provider");
}

/**
 * An Editor's session, in sync with its room, over `nodes` and `edges`
 * (seeded outside the undo history).
 */
function editing(nodes: FlowNode[], edges: FlowEdge[]) {
  const doc = seeded(nodes, edges);
  const session = makeSession("cloud", "f", doc, noopSync, false, "editor", statusOf("connected"));
  return { doc, session };
}

const edgeIds = (doc: FlowDocument) => doc.getEdgeIds().sort();

/** A node to wire from and to, whose own handles never change. */
const OTHER = plug("other", ["in"], ["out"]);

/** `p` takes `a` and `b`; an edge at each. */
const twoPorts = () =>
  editing(
    [OTHER, plug("p", ["a", "b"])],
    [edge("to-a", "other", "out", "p", "a"), edge("to-b", "other", "out", "p", "b")],
  );

describe("a handle that vanishes takes its edges with it", () => {
  test("the edge at a removed handle goes, the edge at a kept one stays", () => {
    const { doc, session } = twoPorts();
    doc.updateNodeData("p", { ports: ["a", "c"] });
    expect(edgeIds(doc)).toEqual(["to-a"]);
    session.destroy();
  });

  test("a handle that is added removes nothing", () => {
    const { doc, session } = twoPorts();
    doc.updateNodeData("p", { ports: ["a", "b", "c"] });
    expect(edgeIds(doc)).toEqual(["to-a", "to-b"]);
    session.destroy();
  });

  test("a Port and an Emit with the same id are told apart", () => {
    const { doc, session } = editing(
      [OTHER, plug("p", ["value", "min"], ["value"])],
      [
        edge("to-value", "other", "out", "p", "value"),
        edge("to-min", "other", "out", "p", "min"),
        edge("from-value", "p", "value", "other", "in"),
      ],
    );

    doc.updateNodeData("p", { ports: [], emits: ["value"] });
    expect(edgeIds(doc)).toEqual(["from-value"]);

    doc.updateNodeData("p", { emits: [] });
    expect(edgeIds(doc)).toEqual([]);
    session.destroy();
  });

  test("a batch that removes a handle and wires a new one keeps the new edge", () => {
    // What Ask AI's `applyChanges` does: several edits, one transaction.
    const { doc, session } = twoPorts();
    doc.doc.transact(() => {
      doc.updateNodeData("p", { ports: ["c"] });
      doc.addEdge(edge("to-c", "other", "out", "p", "c"));
    }, "local");
    expect(edgeIds(doc)).toEqual(["to-c"]);
    session.destroy();
  });

  test("moving the node, or an edit that leaves its handles alone, removes nothing", () => {
    const { doc, session } = twoPorts();
    doc.updateNodeData("p", { label: "renamed" });
    doc.updateNodePosition("p", { x: 40, y: 40 });
    expect(edgeIds(doc)).toEqual(["to-a", "to-b"]);
    session.destroy();
  });
});

describe("the trigger is the document, not a mounted node", () => {
  test("a collaborator's settings change is pruned here too", () => {
    const { doc, session } = twoPorts();
    fromPeer(doc, (peer) => peer.updateNodeData("p", { ports: ["a"] }));
    expect(doc.getNode("p")?.data.ports).toEqual(["a"]);
    expect(edgeIds(doc)).toEqual(["to-a"]);
    session.destroy();
  });

  test("a handle this client never saw the node offer is never removed", () => {
    // A peer on a newer build may offer a handle this build has never heard
    // of. It was never in this client's set, so it cannot vanish from it.
    const { doc, session } = editing(
      [OTHER, plug("p", ["a"])],
      [edge("to-future", "other", "out", "p", "future-port")],
    );
    doc.updateNodeData("p", { ports: [] });
    doc.updateNodeData("p", { ports: ["a"] });
    expect(edgeIds(doc)).toEqual(["to-future"]);
    session.destroy();
  });

  test("a node whose handles are unknown is left alone", () => {
    const { doc, session } = editing(
      [OTHER, { id: "new", type: "NotYetInvented", position: { x: 0, y: 0 }, data: { ports: ["a"] } }],
      [edge("to-new", "other", "out", "new", "a")],
    );
    doc.updateNodeData("new", { ports: [] });
    expect(edgeIds(doc)).toEqual(["to-new"]);
    session.destroy();
  });

  test("starting does not sweep edges that are already at no handle", () => {
    const { doc, session } = editing(
      [OTHER, plug("p", ["a"])],
      [edge("stale", "other", "out", "p", "long-gone")],
    );
    expect(edgeIds(doc)).toEqual(["stale"]);
    session.destroy();
  });

  test("a Viewer's session never prunes", () => {
    const doc = seeded(
      [OTHER, plug("p", ["a"])],
      [edge("to-a", "other", "out", "p", "a")],
    );
    const session = makeSession("cloud", "f", doc, noopSync, true, "viewer");
    fromPeer(doc, (peer) => peer.updateNodeData("p", { ports: [] }));
    expect(doc.getNode("p")?.data.ports).toEqual([]);
    expect(edgeIds(doc)).toEqual(["to-a"]);
    session.destroy();
  });

  test("destroying the session stops the pruning", () => {
    const { doc, session } = twoPorts();
    doc.destroy = () => {}; // keep the document usable after the session is gone
    session.destroy();
    doc.updateNodeData("p", { ports: [] });
    expect(edgeIds(doc)).toEqual(["to-a", "to-b"]);
  });

});

describe("a session made before the app said what a node's handles are", () => {
  // It cannot prune, and nothing else would show that: it says so, through
  // `reportError` (which writes to the console), once.
  let reported: ReturnType<typeof spyOn>;
  beforeEach(() => {
    reported = spyOn(console, "error").mockImplementation(() => {});
    provideHandleSets(null);
  });
  afterEach(() => reported.mockRestore());

  test("does not prune, and reports the missing wiring", () => {
    const { doc, session } = twoPorts();
    doc.updateNodeData("p", { ports: [] });

    expect(edgeIds(doc)).toEqual(["to-a", "to-b"]);
    expect(reported).toHaveBeenCalledTimes(1);
    expect(String(reported.mock.calls[0]?.[1])).toContain("provideHandleSets");
    session.destroy();
  });

  test("reports once, however many sessions start", () => {
    const sessions = [twoPorts(), twoPorts(), twoPorts()];
    expect(reported).toHaveBeenCalledTimes(1);
    for (const { session } of sessions) session.destroy();
  });

  test("a read-only session has nothing to report: it never prunes anyway", () => {
    const doc = seeded([OTHER, plug("p", ["a"])], []);
    const session = makeSession("cloud", "f", doc, noopSync, true, "viewer");
    expect(reported).not.toHaveBeenCalled();
    session.destroy();
  });
});

describe("content that is replaced or loaded is not a settings change", () => {
  // In all of these the incoming flow holds an edge at `p.a` although its `p`
  // does not offer `a`: saved content may, and loading it must not edit it.
  const INCOMING_NODES = [OTHER, plug("p", [])];
  const INCOMING_EDGES = [edge("kept", "other", "out", "p", "a")];

  test("replacing the flow keeps an incoming edge, even when a node id was in use before", () => {
    // The local flow held a `p` that offered `a`. A template whose `p` (same
    // id, templates have fixed ids) does not offer it lands on top.
    const { doc, session } = twoPorts();
    doc.setFlowData(INCOMING_NODES, INCOMING_EDGES);
    expect(edgeIds(doc)).toEqual(["kept"]);
    session.destroy();
  });

  test("replacing the flow with the same content again changes nothing", () => {
    const { doc, session } = editing([], []);
    doc.setFlowData(INCOMING_NODES, INCOMING_EDGES);
    doc.setFlowData(INCOMING_NODES, INCOMING_EDGES);
    expect(edgeIds(doc)).toEqual(["kept"]);
    session.destroy();
  });

  test("undoing and redoing a replacement restores each flow whole", () => {
    const { doc, session } = twoPorts();
    doc.undoManager.stopCapturing();
    doc.setFlowData(INCOMING_NODES, INCOMING_EDGES);

    doc.undo();
    expect(doc.getNode("p")?.data.ports).toEqual(["a", "b"]);
    expect(edgeIds(doc)).toEqual(["to-a", "to-b"]);

    doc.redo();
    expect(doc.getNode("p")?.data.ports).toEqual([]);
    expect(edgeIds(doc)).toEqual(["kept"]);
    session.destroy();
  });

  test("a node that is replaced by one of another type is a new node", () => {
    const { doc, session } = twoPorts();
    doc.updateNode("p", { type: "NotYetInvented" });
    doc.updateNode("p", { type: "Plug", data: { ports: [], emits: [] } });
    expect(edgeIds(doc)).toEqual(["to-a", "to-b"]);
    session.destroy();
  });

  test("the stored document loading into a local session, in one step or several", () => {
    const stored = seeded([OTHER, plug("p", ["a"])], [edge("kept", "other", "out", "p", "a")]);
    const base = Y.encodeStateAsUpdate(stored.doc);
    // A later stored update: a build that did not prune took `a` off `p`.
    const later = updateFrom(stored, (copy) => copy.updateNodeData("p", { ports: [] }));

    const doc = FlowDocument.createEmpty();
    const session = makeSession("local", "local", doc, noopSync, false);
    Y.applyUpdate(doc.doc, base, "indexeddb");
    Y.applyUpdate(doc.doc, later, "indexeddb");

    expect(doc.getNode("p")?.data.ports).toEqual([]);
    expect(edgeIds(doc)).toEqual(["kept"]);
    session.destroy();
  });

  test("a cloud session's first sync on top of its seed", () => {
    // The seed is an older snapshot; since then a peer took `a` off `p` and
    // left the edge. That arrives with the first sync: it is the document
    // loading, not somebody editing.
    const doc = seeded([OTHER, plug("p", ["a"])], [edge("kept", "other", "out", "p", "a")]);
    const sinceSeed = updateFrom(doc, (copy) => copy.updateNodeData("p", { ports: [] }));
    const status = statusOf("syncing");
    const session = makeSession("cloud", "f", doc, noopSync, false, "editor", status);

    Y.applyUpdate(doc.doc, sinceSeed, "provider");
    status.set("connected");

    expect(doc.getNode("p")?.data.ports).toEqual([]);
    expect(edgeIds(doc)).toEqual(["kept"]);
    session.destroy();
  });

  test("a session that was live before prunes what it missed once it is live again, not while it catches up", () => {
    // Unlike a first load, this session saw `p` offer `a`: that is a real
    // "before". But a catch-up is half a picture, so it waits for the end.
    const doc = seeded([OTHER, plug("p", ["a"])], [edge("to-a", "other", "out", "p", "a")]);
    const status = statusOf("connected");
    const session = makeSession("cloud", "f", doc, noopSync, false, "editor", status);

    status.set("offline");
    const missed = updateFrom(doc, (copy) => copy.updateNodeData("p", { ports: [] }));
    status.set("syncing");
    Y.applyUpdate(doc.doc, missed, "provider");
    expect(edgeIds(doc)).toEqual(["to-a"]);

    status.set("connected");
    expect(edgeIds(doc)).toEqual([]);
    // Not this user's edit, so not theirs to undo.
    expect(doc.canUndo()).toBe(false);
    session.destroy();
  });

  test("a handle that vanished and came back during the catch-up keeps its edge", () => {
    const doc = seeded([OTHER, plug("p", ["a"])], [edge("to-a", "other", "out", "p", "a")]);
    const status = statusOf("connected");
    const session = makeSession("cloud", "f", doc, noopSync, false, "editor", status);

    status.set("offline");
    const first = updateFrom(doc, (copy) => copy.updateNodeData("p", { ports: [] }));
    status.set("syncing");
    Y.applyUpdate(doc.doc, first, "provider");
    fromPeer(doc, (peer) => peer.updateNodeData("p", { ports: ["a"] }));
    status.set("connected");

    expect(edgeIds(doc)).toEqual(["to-a"]);
    session.destroy();
  });

  test("once it is live, a peer's settings change is pruned, and the session's own always is", () => {
    const doc = seeded(
      [OTHER, plug("p", ["a", "b"])],
      [edge("to-a", "other", "out", "p", "a"), edge("to-b", "other", "out", "p", "b")],
    );
    const status = statusOf("syncing");
    const session = makeSession("cloud", "f", doc, noopSync, false, "editor", status);

    // The user's own edit, made before the first sync finished.
    doc.updateNodeData("p", { ports: ["a"] });
    expect(edgeIds(doc)).toEqual(["to-a"]);

    status.set("saved");
    const live = updateFrom(doc, (copy) => copy.updateNodeData("p", { ports: [] }));
    Y.applyUpdate(doc.doc, live, "provider");
    expect(edgeIds(doc)).toEqual([]);
    session.destroy();
  });

  test("a document upgraded from the old node shape at the load boundary", () => {
    const doc = FlowDocument.createEmpty();
    doc.doc.transact(() => {
      doc.addNode(OTHER);
      // The pre-ADR-0019 shape: a node as one plain object.
      (doc.nodes as Y.Map<unknown>).set("p", {
        id: "p",
        type: "Plug",
        position: { x: 0, y: 0 },
        data: { ports: ["a"], emits: [] },
      });
      doc.addEdge(edge("to-a", "other", "out", "p", "a"));
      doc.addEdge(edge("stale", "other", "out", "p", "gone"));
    }, "seed");
    const session = makeSession("local", "local", doc, noopSync, false);

    upgradeLegacyNodes(doc.doc);

    expect(edgeIds(doc)).toEqual(["stale", "to-a"]);
    // From here on it is an ordinary node.
    doc.updateNodeData("p", { ports: [] });
    expect(edgeIds(doc)).toEqual(["stale"]);
    session.destroy();
  });
});

describe("it never throws into the document", () => {
  const failing: HandleSets = () => {
    throw new Error("a rule that cannot cope with this node");
  };

  // The failure is reported (`reportError` writes it to the console) instead.
  let reported: ReturnType<typeof spyOn>;
  beforeEach(() => {
    reported = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => reported.mockRestore());

  test("a session can be made over a node whose handles cannot be worked out", () => {
    provideHandleSets(failing);
    const doc = seeded([OTHER, plug("p", ["a"])], [edge("to-a", "other", "out", "p", "a")]);
    const session = makeSession("local", "f", doc, noopSync, false);
    expect(edgeIds(doc)).toEqual(["to-a"]);
    expect(reported).toHaveBeenCalled();
    session.destroy();
  });

  test("a remote update still applies when working out the handles fails afterwards", () => {
    let fail = false;
    provideHandleSets((node) => {
      if (fail) throw new Error("cannot cope");
      return plugHandles(node);
    });
    const { doc, session } = twoPorts();
    const update = updateFrom(doc, (peer) => peer.updateNodeData("p", { ports: [] }));

    fail = true;
    expect(() => Y.applyUpdate(doc.doc, update, "provider")).not.toThrow();
    expect(doc.getNode("p")?.data.ports).toEqual([]);
    // Unknown is not "has no handles": nothing is removed on a failure.
    expect(edgeIds(doc)).toEqual(["to-a", "to-b"]);
    expect(reported).toHaveBeenCalled();
    session.destroy();
  });
});

describe("undo", () => {
  test("the user's own change and its pruning are one undo step", () => {
    const { doc, session } = twoPorts();

    doc.updateNodeData("p", { ports: ["a"] });
    expect(edgeIds(doc)).toEqual(["to-a"]);

    doc.undo();
    expect(doc.getNode("p")?.data.ports).toEqual(["a", "b"]);
    expect(edgeIds(doc)).toEqual(["to-a", "to-b"]);

    doc.redo();
    expect(doc.getNode("p")?.data.ports).toEqual(["a"]);
    expect(edgeIds(doc)).toEqual(["to-a"]);
    session.destroy();
  });

  test("pruning after a collaborator's change is not on this client's undo stack", () => {
    const { doc, session } = twoPorts();
    fromPeer(doc, (peer) => peer.updateNodeData("p", { ports: [] }));
    expect(edgeIds(doc)).toEqual([]);
    expect(doc.canUndo()).toBe(false);
    session.destroy();
  });
});

describe("two clients", () => {
  /** Two Editors on one flow, with updates held until `exchange()`. */
  function pair(nodes: FlowNode[], edges: FlowEdge[]) {
    const a = seeded(nodes, edges);
    const b = FlowDocument.createEmpty();
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const sessions = [a, b].map((doc) =>
      makeSession("cloud", "f", doc, noopSync, false, "editor", statusOf("connected")),
    );
    const exchange = () => {
      const toB = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
      const toA = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
      Y.applyUpdate(b.doc, toB, "remote");
      Y.applyUpdate(a.doc, toA, "remote");
    };
    const destroy = () => sessions.forEach((session) => session.destroy());
    return { a, b, exchange, destroy };
  }

  const NODES = [OTHER, plug("p", ["a"])];
  const TO_A = edge("to-a", "other", "out", "p", "a");

  test("both prune the same change and still converge", () => {
    const { a, b, exchange, destroy } = pair(NODES, [TO_A]);

    // A's two transactions, in the order a provider would send them.
    const fromA: Uint8Array[] = [];
    a.doc.on("update", (update: Uint8Array) => fromA.push(update));
    a.updateNodeData("p", { ports: [] });
    expect(fromA).toHaveLength(2); // the settings change, then A's removal

    // Only the settings change has arrived: B removes the edge on its own.
    Y.applyUpdate(b.doc, fromA[0], "remote");
    expect(edgeIds(b)).toEqual([]);

    // Now A's removal of the same edge arrives, and B's reaches A.
    Y.applyUpdate(b.doc, fromA[1], "remote");
    exchange();

    expect(a.getFlowData()).toEqual(b.getFlowData());
    expect(edgeIds(a)).toEqual([]);
    expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));
    destroy();
  });

  test("a settings change racing a peer's new edge to the vanishing handle leaves no edge behind", () => {
    const { a, b, exchange, destroy } = pair(NODES, []);

    // Concurrent, each valid where it was made.
    a.updateNodeData("p", { ports: [] });
    b.addEdge(edge("late", "other", "out", "p", "a"));
    exchange();
    exchange(); // carry the prune itself across

    expect(edgeIds(a)).toEqual([]);
    expect(edgeIds(b)).toEqual([]);
    destroy();
  });

  test("undoing the change brings the edges back for both", () => {
    const { a, b, exchange, destroy } = pair(NODES, [TO_A]);

    a.updateNodeData("p", { ports: [] });
    exchange();
    exchange();
    a.undo();
    exchange();
    exchange();

    for (const doc of [a, b]) {
      expect(doc.getNode("p")?.data.ports).toEqual(["a"]);
      expect(doc.getEdges().map((e) => e.targetHandle)).toEqual(["a"]);
    }
    destroy();
  });
});

describe("two clients, with one or both of them offline for a while", () => {
  /**
   * Two Editors on one flow, each with its own connection. Nothing travels
   * until a test says so, and a client that is offline neither sends nor
   * receives.
   */
  function room(nodes: FlowNode[], edges: FlowEdge[]) {
    const docs = { a: seeded(nodes, edges), b: FlowDocument.createEmpty() };
    Y.applyUpdate(docs.b.doc, Y.encodeStateAsUpdate(docs.a.doc));
    const status = { a: statusOf("connected"), b: statusOf("connected") };
    const sessions = (["a", "b"] as const).map((who) =>
      makeSession("cloud", "f", docs[who], noopSync, false, "editor", status[who]),
    );
    type Who = "a" | "b";
    const online = (who: Who) => status[who].getSnapshot().kind !== "offline";
    const deliver = (from: Who, to: Who) => {
      const update = Y.encodeStateAsUpdate(docs[from].doc, Y.encodeStateVector(docs[to].doc));
      Y.applyUpdate(docs[to].doc, update, "provider");
    };
    return {
      ...docs,
      goOffline: (who: Who) => status[who].set("offline"),
      /** `who` comes back: it catches up from the room, then is live again. */
      reconnect(who: Who) {
        const peer: Who = who === "a" ? "b" : "a";
        status[who].set("syncing");
        if (online(peer)) {
          deliver(peer, who);
          deliver(who, peer);
        }
        status[who].set("connected");
      },
      /** Let everything in flight between two online clients arrive. */
      settle() {
        for (let round = 0; round < 3; round++) {
          if (online("a") && online("b")) {
            deliver("a", "b");
            deliver("b", "a");
          }
        }
      },
      destroy: () => sessions.forEach((session) => session.destroy()),
    };
  }

  const NODES = [OTHER, plug("p", ["a"])];
  const WIRE = edge("wired-offline", "other", "out", "p", "a");

  test("an edge wired offline at a handle a peer removed meanwhile does not survive the reconnect", () => {
    const r = room(NODES, []);

    r.goOffline("b");
    r.b.addEdge(WIRE);
    r.a.updateNodeData("p", { ports: [] });

    r.reconnect("b");
    r.settle();

    expect(edgeIds(r.a)).toEqual([]);
    expect(edgeIds(r.b)).toEqual([]);
    expect(r.a.getFlowData()).toEqual(r.b.getFlowData());
    r.destroy();
  });

  test("the same when the settings change was the one made offline", () => {
    const r = room(NODES, []);

    r.goOffline("a");
    r.a.updateNodeData("p", { ports: [] });
    r.b.addEdge(WIRE);

    r.reconnect("a");
    r.settle();

    expect(edgeIds(r.a)).toEqual([]);
    expect(edgeIds(r.b)).toEqual([]);
    r.destroy();
  });

  test.each([
    ["a", "b"],
    ["b", "a"],
  ] as const)("both were offline, %s is back first: they converge on no edge", (first, second) => {
    const r = room(NODES, []);

    r.goOffline("a");
    r.goOffline("b");
    r.a.updateNodeData("p", { ports: [] });
    r.b.addEdge(WIRE);

    r.reconnect(first);
    r.reconnect(second);
    r.settle();

    expect(edgeIds(r.a)).toEqual([]);
    expect(edgeIds(r.b)).toEqual([]);
    expect(r.a.getFlowData()).toEqual(r.b.getFlowData());
    r.destroy();
  });

  test("an offline period without a settings change removes nothing", () => {
    const r = room(NODES, [edge("to-a", "other", "out", "p", "a")]);

    r.goOffline("b");
    r.b.addEdge(WIRE);
    r.a.updateNodeData("p", { label: "renamed" });
    r.a.updateNodePosition("p", { x: 10, y: 10 });

    r.reconnect("b");
    r.settle();

    expect(edgeIds(r.a)).toEqual(["to-a", "wired-offline"]);
    expect(edgeIds(r.b)).toEqual(["to-a", "wired-offline"]);
    r.destroy();
  });
});

describe("an edge is never removed because it arrived", () => {
  // Pruning reacts to a handle vanishing. An edge that turns up at a handle
  // the node does not offer is left where it is, whoever made it and however
  // recently this client saw that handle go.

  test("a peer's edge at a handle this client saw vanish stays", () => {
    const { doc, session } = editing([OTHER, plug("p", ["a"])], []);

    // The peer wired `p.a` before it had heard of this.
    const wire = updateFrom(doc, (peer) => peer.addEdge(edge("late", "other", "out", "p", "a")));
    doc.updateNodeData("p", { ports: [] });
    Y.applyUpdate(doc.doc, wire, "provider");

    // An accepted residue here: the peer removes it when the change reaches it.
    expect(edgeIds(doc)).toEqual(["late"]);
    session.destroy();
  });

  test("the user's own edge at such a handle stays", () => {
    const { doc, session } = editing([OTHER, plug("p", ["a"])], []);

    doc.updateNodeData("p", { ports: [] });
    doc.addEdge(edge("own", "other", "out", "p", "a"));
    doc.updateNodeData("p", { label: "renamed" });

    expect(edgeIds(doc)).toEqual(["own"]);
    session.destroy();
  });

  test("an edge the user wired offline at a handle that was already gone survives the reconnect", () => {
    // The handle went while the session was live; that is not something the
    // catch-up brought, so the reconnect has nothing to say about it.
    const doc = seeded([OTHER, plug("p", ["a"])], []);
    const status = statusOf("connected");
    const session = makeSession("cloud", "f", doc, noopSync, false, "editor", status);

    fromPeer(doc, (peer) => peer.updateNodeData("p", { ports: [] }));
    status.set("offline");
    doc.addEdge(edge("own-offline", "other", "out", "p", "a"));
    status.set("syncing");
    fromPeer(doc, (peer) => peer.updateNodeData("p", { label: "renamed meanwhile" }));
    status.set("connected");

    expect(edgeIds(doc)).toEqual(["own-offline"]);
    session.destroy();
  });

  test("what a catch-up noted is forgotten once it has been acted on", () => {
    const doc = seeded([OTHER, plug("p", ["a"])], [edge("to-a", "other", "out", "p", "a")]);
    const status = statusOf("connected");
    const session = makeSession("cloud", "f", doc, noopSync, false, "editor", status);

    // One catch-up in which `a` goes: its edge goes with the reconnect.
    status.set("offline");
    status.set("syncing");
    fromPeer(doc, (peer) => peer.updateNodeData("p", { ports: [] }));
    status.set("connected");
    expect(edgeIds(doc)).toEqual([]);

    // A later edge at `a`, and a second reconnect in which nothing vanishes.
    fromPeer(doc, (peer) => peer.addEdge(edge("later", "other", "out", "p", "a")));
    status.set("offline");
    status.set("syncing");
    status.set("connected");

    expect(edgeIds(doc)).toEqual(["later"]);
    session.destroy();
  });

  test("a node whose handles cannot be worked out any more is not acted on at the reconnect", () => {
    const reported = spyOn(console, "error").mockImplementation(() => {});
    provideHandleSets((node) => {
      if (node.data.poison) throw new Error("cannot cope");
      return plugHandles(node);
    });
    const doc = seeded([OTHER, plug("p", ["a"])], [edge("to-a", "other", "out", "p", "a")]);
    const status = statusOf("connected");
    const session = makeSession("cloud", "f", doc, noopSync, false, "editor", status);

    status.set("offline");
    status.set("syncing");
    fromPeer(doc, (peer) => peer.updateNodeData("p", { ports: [] }));
    fromPeer(doc, (peer) => peer.updateNodeData("p", { poison: true }));
    status.set("connected");

    // What was noted for `p` came from an answer that no longer holds.
    expect(edgeIds(doc)).toEqual(["to-a"]);
    expect(reported).toHaveBeenCalled();
    reported.mockRestore();
    session.destroy();
  });
});

describe("two clients whose builds disagree about a node's handles", () => {
  // OLD's rule takes `t` off a Plug in mode "b"; NEW's keeps it. Each session
  // is handed its own build's handle sets.
  const newer: HandleSets = plugHandles;
  const older: HandleSets = (node) => {
    const set = plugHandles(node);
    if (!set || node.data.mode !== "b") return set;
    return { ports: set.ports.filter((port) => port !== "t"), emits: set.emits };
  };

  function skewed() {
    const NODES = [OTHER, { ...plug("p", ["t", "u"]), data: { ports: ["t", "u"], emits: [], mode: "a" } }];
    const docs = {
      old: seeded(NODES, [edge("to-t", "other", "out", "p", "t"), edge("to-u", "other", "out", "p", "u")]),
      new: FlowDocument.createEmpty(),
    };
    Y.applyUpdate(docs.new.doc, Y.encodeStateAsUpdate(docs.old.doc));
    const status = { old: statusOf("connected"), new: statusOf("connected") };
    provideHandleSets(older);
    const oldSession = makeSession("cloud", "f", docs.old, noopSync, false, "editor", status.old);
    provideHandleSets(newer);
    const newSession = makeSession("cloud", "f", docs.new, noopSync, false, "editor", status.new);
    type Who = "old" | "new";
    const deliver = (from: Who, to: Who) => {
      const update = Y.encodeStateAsUpdate(docs[from].doc, Y.encodeStateVector(docs[to].doc));
      Y.applyUpdate(docs[to].doc, update, "provider");
    };
    const settle = () => {
      for (let round = 0; round < 3; round++) {
        deliver("old", "new");
        deliver("new", "old");
      }
    };
    return {
      ...docs,
      status,
      deliver,
      settle,
      destroy() {
        oldSession.destroy();
        newSession.destroy();
      },
    };
  }

  const REWIRED = edge("rewired", "other", "out", "p", "t");

  test("the stricter build removes the edge once; wired again, it stays on both", () => {
    const r = skewed();

    // NEW changes the setting. For NEW nothing vanished; for OLD `t` did.
    r.new.updateNodeData("p", { mode: "b" });
    r.settle();
    expect(edgeIds(r.old)).toEqual(["to-u"]);
    expect(edgeIds(r.new)).toEqual(["to-u"]);

    // NEW's user wires `t` again, more than once, with an unrelated edit between.
    for (const attempt of [1, 2, 3]) {
      r.new.addEdge({ ...REWIRED, id: `rewired-${attempt}` });
      r.new.updateNodeData("p", { label: `attempt ${attempt}` });
      r.settle();
    }

    const kept = ["rewired-1", "rewired-2", "rewired-3", "to-u"];
    expect(edgeIds(r.old)).toEqual(kept);
    expect(edgeIds(r.new)).toEqual(kept);
    r.destroy();
  });

  test("and it survives the stricter build reconnecting", () => {
    const r = skewed();
    r.new.updateNodeData("p", { mode: "b" });
    r.settle();
    r.new.addEdge(REWIRED);
    r.settle();

    r.status.old.set("offline");
    r.new.updateNodeData("p", { label: "edited while OLD was away" });
    r.status.old.set("syncing");
    r.deliver("new", "old");
    r.deliver("old", "new");
    r.status.old.set("connected");
    r.settle();

    expect(edgeIds(r.old)).toEqual(["rewired", "to-u"]);
    expect(edgeIds(r.new)).toEqual(["rewired", "to-u"]);
    r.destroy();
  });

  test("the same when the edge was wired while the stricter build was away", () => {
    const r = skewed();
    r.new.updateNodeData("p", { mode: "b" });
    r.settle();

    r.status.old.set("offline");
    r.new.addEdge(REWIRED);
    r.new.updateNodeData("p", { label: "edited while OLD was away" });
    r.status.old.set("syncing");
    r.deliver("new", "old");
    r.deliver("old", "new");
    r.status.old.set("connected");
    r.settle();

    expect(edgeIds(r.old)).toEqual(["rewired", "to-u"]);
    expect(edgeIds(r.new)).toEqual(["rewired", "to-u"]);
    r.destroy();
  });

  test("the other way round: the stricter build changes the setting, the edge goes once", () => {
    const r = skewed();

    r.old.updateNodeData("p", { mode: "b" });
    r.settle();
    expect(edgeIds(r.new)).toEqual(["to-u"]);

    r.new.addEdge(REWIRED);
    r.old.updateNodeData("p", { label: "an unrelated edit" });
    r.settle();

    expect(edgeIds(r.old)).toEqual(["rewired", "to-u"]);
    expect(edgeIds(r.new)).toEqual(["rewired", "to-u"]);
    r.destroy();
  });

  test("the more lenient build undoing its setting brings nothing back, and nothing goes back and forth", () => {
    // OLD removed `to-t` because NEW's change took `t` away by OLD's rule.
    // NEW's undo is, for OLD, a peer setting the value back: not a revert of
    // a prune OLD may undo, so the edge stays gone (the known property).
    const r = skewed();
    r.new.updateNodeData("p", { mode: "b" });
    r.settle();
    expect(edgeIds(r.old)).toEqual(["to-u"]);

    r.new.undo();
    for (let round = 0; round < 5; round++) r.settle();

    for (const doc of [r.old, r.new]) {
      expect(doc.getNode("p")?.data.mode).toBe("a");
      expect(edgeIds(doc)).toEqual(["to-u"]);
    }
    r.destroy();
  });
});

describe("a prune whose cause is reverted is reverted with it", () => {
  // Every prune follows a transition: a value that took a handle away. When
  // that transition is undone (undo, redo) or loses to a concurrent value, the
  // handle is back and so is what was pruned for it.

  /** A document with a fixed client id, so which concurrent write wins is known. */
  const docOf = (clientID: number) => {
    const ydoc = new Y.Doc();
    ydoc.clientID = clientID;
    return new FlowDocument(ydoc);
  };

  /**
   * Editors on one flow, with fixed client ids. Nothing travels until
   * `exchange()`, which delivers until every client holds everything.
   */
  function clients(ids: readonly number[], nodes: FlowNode[], edges: FlowEdge[]) {
    const docs = ids.map(docOf);
    docs[0].doc.transact(() => {
      for (const n of nodes) docs[0].addNode(n);
      for (const e of edges) docs[0].addEdge(e);
    }, "seed");
    for (const doc of docs.slice(1)) Y.applyUpdate(doc.doc, Y.encodeStateAsUpdate(docs[0].doc), "seed");
    const sessions = docs.map((doc) =>
      makeSession("cloud", "f", doc, noopSync, false, "editor", statusOf("connected")),
    );
    const deliver = (from: FlowDocument, to: FlowDocument) =>
      Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "provider");
    const exchange = () => {
      for (let round = 0; round < 4; round++) {
        for (const from of docs) for (const to of docs) if (from !== to) deliver(from, to);
      }
    };
    const destroy = () => sessions.forEach((session) => session.destroy());
    return { docs, deliver, exchange, destroy };
  }

  const ports = (doc: FlowDocument) => doc.getNode("p")?.data.ports;
  const E = edge("e", "other", "out", "p", "a");

  test("an undo prunes a peer's edge, and the redo brings it back for both", () => {
    // A offers `a` on `p`; B wires it; A undoes, then redoes, twice over.
    const { docs, exchange, destroy } = clients([1, 2], [OTHER, plug("p", [])], []);
    const [a, b] = docs;
    a.updateNodeData("p", { ports: ["a"] });
    exchange();
    b.addEdge(E);
    exchange();

    for (const round of [1, 2]) {
      a.undo();
      exchange();
      for (const doc of docs) {
        expect(ports(doc)).toEqual([]);
        expect(edgeIds(doc)).toEqual([]);
      }

      a.redo();
      exchange();
      for (const doc of docs) {
        expect([round, ports(doc)]).toEqual([round, ["a"]]);
        expect(doc.getEdges()).toEqual([E]);
      }
    }
    expect(a.getFlowData()).toEqual(b.getFlowData());
    destroy();
  });

  test("one user: a setting that removes a handle, then undo, redo, undo, redo — the edge follows the setting", () => {
    const { docs, exchange, destroy } = clients(
      [1, 2],
      [OTHER, plug("p", ["a", "b"])],
      [edge("to-a", "other", "out", "p", "a"), edge("to-b", "other", "out", "p", "b")],
    );
    const [a] = docs;

    a.updateNodeData("p", { ports: ["a"] });
    exchange();
    for (const step of ["undo", "redo", "undo", "redo", "undo"] as const) {
      a[step]();
      exchange();
      const expected = step === "undo" ? ["to-a", "to-b"] : ["to-a"];
      for (const doc of docs) expect([step, edgeIds(doc)]).toEqual([step, expected]);
    }
    destroy();
  });

  // The client with the higher id wins a concurrent write of one key.
  test.each([
    ["the value that removes the handle wins", 2, 1],
    ["the value that keeps the handle wins", 1, 2],
  ] as const)("two users set the same setting at once: %s", (_, removerId, keeperId) => {
    const { docs, exchange, destroy } = clients(
      [removerId, keeperId],
      [OTHER, plug("p", ["a"])],
      [E],
    );
    const [remover, keeper] = docs;

    remover.updateNodeData("p", { ports: [] });
    keeper.updateNodeData("p", { ports: ["a", "c"] });
    exchange();

    const keeperWon = keeperId > removerId;
    for (const doc of docs) {
      expect(ports(doc)).toEqual(keeperWon ? ["a", "c"] : []);
      expect(doc.getEdges()).toEqual(keeperWon ? [E] : []);
    }
    expect(remover.getFlowData()).toEqual(keeper.getFlowData());
    destroy();
  });

  test("the same when the value that loses was set offline and the winner arrives in the catch-up", () => {
    const remover = docOf(1);
    remover.doc.transact(() => {
      remover.addNode(OTHER);
      remover.addNode(plug("p", ["a"]));
      remover.addEdge(E);
    }, "seed");
    const keeper = docOf(2);
    Y.applyUpdate(keeper.doc, Y.encodeStateAsUpdate(remover.doc), "seed");
    const status = statusOf("connected");
    const sessions = [
      makeSession("cloud", "f", remover, noopSync, false, "editor", status),
      makeSession("cloud", "f", keeper, noopSync, false, "editor", statusOf("connected")),
    ];
    const deliver = (from: FlowDocument, to: FlowDocument) =>
      Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "provider");

    status.set("offline");
    remover.updateNodeData("p", { ports: [] });
    expect(edgeIds(remover)).toEqual([]);
    keeper.updateNodeData("p", { ports: ["a", "c"] });
    status.set("syncing");
    deliver(keeper, remover);
    deliver(remover, keeper);
    status.set("connected");
    deliver(remover, keeper);
    deliver(keeper, remover);

    for (const doc of [remover, keeper]) {
      expect(ports(doc)).toEqual(["a", "c"]);
      expect(doc.getEdges()).toEqual([E]);
    }
    sessions.forEach((session) => session.destroy());
  });

  test("a third client that pruned too restores the same edge, once", () => {
    const { docs, deliver, exchange, destroy } = clients([3, 4, 1], [OTHER, plug("p", ["a"])], [E]);
    const [remover, keeper, watcher] = docs;

    remover.updateNodeData("p", { ports: [] });
    keeper.updateNodeData("p", { ports: ["a", "c"] });
    // The watcher sees the losing value first, and prunes for it.
    deliver(remover, watcher);
    expect(edgeIds(watcher)).toEqual([]);
    exchange();

    for (const doc of docs) expect(doc.getEdges()).toEqual([E]);
    destroy();
  });

  test("an edge wired again by hand is not restored beside it", () => {
    const { docs, exchange, destroy } = clients([1, 2], [OTHER, plug("p", ["a"])], [E]);
    const [remover, keeper] = docs;
    const again = edge("again", "other", "out", "p", "a");

    remover.updateNodeData("p", { ports: [] });
    keeper.updateNodeData("p", { ports: ["a", "c"] });
    keeper.doc.transact(() => keeper.removeEdge(E.id), "local");
    keeper.addEdge(again);
    exchange();

    for (const doc of docs) expect(doc.getEdges()).toEqual([again]);
    destroy();
  });

  test("an edge deleted on purpose after it was restored stays deleted", () => {
    const { docs, exchange, destroy } = clients([1, 2], [OTHER, plug("p", [])], []);
    const [a, b] = docs;
    a.updateNodeData("p", { ports: ["a"] });
    exchange();
    b.addEdge(E);
    exchange();
    a.undo();
    exchange();
    a.redo();
    exchange();
    expect(edgeIds(b)).toEqual(["e"]);

    b.removeEdge(E.id);
    exchange();
    a.undo();
    exchange();
    a.redo();
    exchange();

    for (const doc of docs) {
      expect(ports(doc)).toEqual(["a"]);
      expect(edgeIds(doc)).toEqual([]);
    }
    destroy();
  });

  test("an edge that came back without its handle, then was deleted on purpose, is not restored", () => {
    // A's undo brings `e` back but not the setting, which a peer has changed
    // since: an edge at a handle `p` does not offer. Someone deletes it on
    // purpose. A value written before any of this then wins and offers `a`.
    const { docs, deliver, exchange, destroy } = clients([2, 3, 4], [OTHER, plug("p", ["a"])], [E]);
    const [a, b, late] = docs;

    late.updateNodeData("p", { ports: ["a", "late"] });
    a.updateNodeData("p", { ports: [] });
    deliver(a, b);
    b.updateNodeData("p", { ports: ["b"] });
    deliver(b, a);
    a.undo();
    deliver(a, b);
    expect(ports(a)).toEqual(["b"]);
    expect(edgeIds(a)).toEqual(["e"]);

    a.removeEdge(E.id);
    deliver(a, b);
    exchange();

    expect(ports(a)).toEqual(["a", "late"]);
    for (const doc of docs) expect(edgeIds(doc)).toEqual([]);
    destroy();
  });

  test("setting the value back by hand is a new change: nothing is restored", () => {
    const { docs, exchange, destroy } = clients([1, 2], [OTHER, plug("p", ["a"])], [E]);
    const [a, b] = docs;

    a.updateNodeData("p", { ports: [] });
    exchange();
    b.updateNodeData("p", { ports: ["a"] });
    exchange();
    a.undoManager.stopCapturing();
    a.updateNodeData("p", { ports: ["a", "c"] });
    exchange();

    for (const doc of docs) expect(edgeIds(doc)).toEqual([]);
    destroy();
  });

  test("a restore is checked against the handles the node offers now", () => {
    // B's edge at `p.a` was pruned by A's undo. Before A redoes, `other`
    // stopped offering `out`: the edge would attach to nothing, so it stays gone.
    const { docs, exchange, destroy } = clients([1, 2], [OTHER, plug("p", [])], []);
    const [a, b] = docs;
    a.updateNodeData("p", { ports: ["a"] });
    exchange();
    b.addEdge(E);
    exchange();
    a.undo();
    exchange();
    b.updateNodeData("other", { emits: [] });
    exchange();
    a.redo();
    exchange();

    for (const doc of docs) expect(edgeIds(doc)).toEqual([]);
    destroy();
  });
});
