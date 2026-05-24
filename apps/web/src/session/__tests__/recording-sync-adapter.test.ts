import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { FlowDocument } from "@microflow/collab";
import { RecordingSyncAdapter } from "../recording-sync-adapter";

function makeAdapter(initialState?: "disconnected" | "connecting" | "syncing" | "synced") {
  const doc = FlowDocument.createEmpty();
  const adapter = new RecordingSyncAdapter({
    doc,
    user: { id: "u1", name: "Alice" },
    initialState,
  });
  return { doc, adapter };
}

describe("RecordingSyncAdapter", () => {
  test("records local updates as appliedUpdates", () => {
    const { doc, adapter } = makeAdapter();
    doc.addNode({ id: "n1", type: "Led", position: { x: 0, y: 0 }, data: {} });
    expect(adapter.appliedUpdates.length).toBe(1);
  });

  test("does not record remote-origin updates as appliedUpdates", () => {
    const { doc, adapter } = makeAdapter();
    Y.transact(
      doc.doc,
      () => {
        doc.nodes.set("n2", { id: "n2", type: "Led", position: { x: 1, y: 1 }, data: {} });
      },
      "remote",
    );
    expect(adapter.appliedUpdates.length).toBe(0);
  });

  test("injectRemoteUpdate writes to the doc with remote origin", () => {
    const { doc: docA, adapter: adapterA } = makeAdapter();
    const { doc: docB, adapter: adapterB } = makeAdapter();

    docA.addNode({ id: "n1", type: "Led", position: { x: 0, y: 0 }, data: {} });
    const update = adapterA.appliedUpdates[0]!;

    adapterB.injectRemoteUpdate(update);

    expect(docB.getNodes()).toHaveLength(1);
    expect(docB.getNodes()[0]!.id).toBe("n1");
    // The remote injection should not be recorded as a local update on B
    expect(adapterB.appliedUpdates.length).toBe(0);
  });

  test("two adapters converge via mutual replay", () => {
    const { doc: docA, adapter: adapterA } = makeAdapter();
    const { doc: docB, adapter: adapterB } = makeAdapter();

    docA.addNode({ id: "a", type: "Led", position: { x: 0, y: 0 }, data: {} });
    docB.addNode({ id: "b", type: "Button", position: { x: 1, y: 1 }, data: {} });

    for (const u of adapterA.appliedUpdates) adapterB.injectRemoteUpdate(u);
    for (const u of adapterB.appliedUpdates) adapterA.injectRemoteUpdate(u);

    const idsA = docA.getNodes().map((n) => n.id).sort();
    const idsB = docB.getNodes().map((n) => n.id).sort();
    expect(idsA).toEqual(["a", "b"]);
    expect(idsB).toEqual(["a", "b"]);
  });

  test("awareness updates are recorded", () => {
    const { adapter } = makeAdapter();
    adapter.updateCursor({ x: 10, y: 20 });
    adapter.updateSelectedNodes(["n1", "n2"]);
    expect(adapter.awarenessUpdates).toEqual([
      { kind: "cursor", payload: { x: 10, y: 20 } },
      { kind: "selection", payload: ["n1", "n2"] },
    ]);
  });

  test("state event fires on inject", () => {
    const { adapter } = makeAdapter("disconnected");
    const seen: string[] = [];
    adapter.on("state", (s) => seen.push(s));
    adapter.injectState("connecting");
    adapter.injectState("syncing");
    adapter.injectState("synced");
    expect(seen).toEqual(["connecting", "syncing", "synced"]);
    expect(adapter.isSynced).toBe(true);
  });

  test("error event fires and is exposed via .error", () => {
    const { adapter } = makeAdapter();
    let captured: Error | null = null;
    adapter.on("error", (e) => {
      captured = e;
    });
    const err = new Error("boom");
    adapter.injectError(err);
    expect(captured).toBe(err);
    expect(adapter.error).toBe(err);
  });

  test("synced event fires after synced state", () => {
    const { adapter } = makeAdapter("disconnected");
    let synced = 0;
    adapter.on("synced", () => synced++);
    adapter.injectState("synced");
    expect(synced).toBe(1);
  });

  test("reconnect and disconnect increment counters", () => {
    const { adapter } = makeAdapter("disconnected");
    adapter.reconnect();
    adapter.reconnect();
    adapter.disconnect();
    expect(adapter.connectCalls).toBe(2);
    expect(adapter.disconnectCalls).toBe(1);
  });

  test("destroy is idempotent", () => {
    const { adapter } = makeAdapter();
    adapter.destroy();
    expect(adapter.destroyed).toBe(true);
    expect(() => adapter.destroy()).not.toThrow();
    expect(adapter.destroyed).toBe(true);
  });

  test("listeners cleared on destroy", () => {
    const { adapter } = makeAdapter();
    let fired = 0;
    adapter.on("state", () => fired++);
    adapter.destroy();
    adapter.injectState("connecting");
    expect(fired).toBe(0);
  });
});
