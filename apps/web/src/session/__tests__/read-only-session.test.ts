import { beforeEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { FlowDocument, type FlowNode } from "@microflow/collab";

import { makeSession } from "../flow-session";
import { readOnlyDocument } from "../read-only-document";
import { ReactFlowBridge } from "../react-flow-bridge";
import type { SyncAdapter } from "../sync-adapter";

const noopSync: SyncAdapter = { kind: "local", destroy() {} };

// bun has no DOM; the bridge schedules its flush on a frame. Tests call
// flush() explicitly, this only keeps scheduleFlush from throwing.
beforeEach(() => {
  (globalThis as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame =
    ((cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(0));
      return 0;
    }) as typeof requestAnimationFrame;
  (globalThis as { cancelAnimationFrame: typeof cancelAnimationFrame }).cancelAnimationFrame =
    (() => {}) as typeof cancelAnimationFrame;
});

function node(id: string, x = 0): FlowNode {
  return { id, type: "Counter", position: { x, y: 0 }, data: {} };
}

describe("readOnlyDocument", () => {
  test("mutations are dropped, reads still work", () => {
    const doc = FlowDocument.createEmpty();
    doc.addNode(node("a"));

    const guarded = readOnlyDocument(doc);
    guarded.addNode(node("b"));
    guarded.updateNodePosition("a", { x: 99, y: 99 });
    guarded.removeNode("a");
    guarded.addEdge({ id: "e1", source: "a", target: "b" });
    guarded.setMeta({ name: "renamed" });
    guarded.clear();

    expect(guarded.getNodes().map((n) => n.id)).toEqual(["a"]);
    expect(guarded.getNode("a")!.position).toEqual({ x: 0, y: 0 });
    expect(guarded.getEdges()).toEqual([]);
    expect(guarded.getMeta().name).not.toBe("renamed");
  });

  test("remote updates still land — the guard is on the local write path only", () => {
    const doc = FlowDocument.createEmpty();
    const guarded = readOnlyDocument(doc);

    // What the sync adapter does when a collaborator's edit arrives.
    const remote = FlowDocument.createEmpty();
    remote.addNode(node("from-peer"));
    Y.applyUpdate(doc.doc, remote.encode());

    expect(guarded.getNodes().map((n) => n.id)).toEqual(["from-peer"]);
  });

  test("observers and history helpers pass through", () => {
    const doc = FlowDocument.createEmpty();
    const guarded = readOnlyDocument(doc);

    let fired = 0;
    const stop = guarded.onNodesChange(() => fired++);
    doc.addNode(node("a"));
    expect(fired).toBe(1);

    stop();
    doc.addNode(node("b"));
    expect(fired).toBe(1);
  });
});

describe("FlowSession role", () => {
  test("a viewer session is read-only and its doc is guarded", () => {
    const doc = FlowDocument.createEmpty();
    const session = makeSession("cloud", "flow-1", doc, noopSync, true, "viewer");

    expect(session.readOnly).toBe(true);
    expect(session.role).toBe("viewer");

    session.doc.addNode(node("a"));
    expect(doc.getNodes()).toEqual([]);
  });

  test("an editor session writes through", () => {
    const doc = FlowDocument.createEmpty();
    const session = makeSession("cloud", "flow-1", doc, noopSync, false, "editor");

    expect(session.readOnly).toBe(false);
    session.doc.addNode(node("a"));
    expect(doc.getNodes().map((n) => n.id)).toEqual(["a"]);
  });

  test("a local session has no role and stays writable", () => {
    const doc = FlowDocument.createEmpty();
    const session = makeSession("local", "local", doc, noopSync, false);

    expect(session.role).toBeNull();
    session.doc.addNode(node("a"));
    expect(doc.getNodes().length).toBe(1);
  });
});

describe("ReactFlowBridge readOnly", () => {
  test("a structural change updates the snapshot but never the doc", () => {
    const doc = FlowDocument.createEmpty();
    doc.addNode(node("a"));
    const bridge = new ReactFlowBridge(doc, { readOnly: true });

    bridge.applyNodeChanges([{ id: "a", type: "position", position: { x: 500, y: 500 } }]);
    bridge.flush();

    expect(bridge.getSnapshot().nodes[0]!.position).toEqual({ x: 500, y: 500 });
    expect(doc.getNode("a")!.position).toEqual({ x: 0, y: 0 });

    bridge.applyNodeChanges([{ id: "a", type: "remove" }]);
    bridge.flush();
    expect(doc.getNodes().length).toBe(1);

    bridge.destroy();
  });

  test("an editable bridge still writes through", () => {
    const doc = FlowDocument.createEmpty();
    doc.addNode(node("a"));
    const bridge = new ReactFlowBridge(doc);

    bridge.applyNodeChanges([{ id: "a", type: "position", position: { x: 500, y: 500 } }]);
    bridge.flush();

    expect(doc.getNode("a")!.position).toEqual({ x: 500, y: 500 });
    bridge.destroy();
  });

  test("remote edits still reach a read-only bridge's snapshot", () => {
    const doc = FlowDocument.createEmpty();
    const bridge = new ReactFlowBridge(doc, { readOnly: true });

    const remote = FlowDocument.createEmpty();
    remote.addNode(node("from-peer"));
    Y.applyUpdate(doc.doc, remote.encode());

    expect(bridge.getSnapshot().nodes.map((n) => n.id)).toEqual(["from-peer"]);
    bridge.destroy();
  });
});
