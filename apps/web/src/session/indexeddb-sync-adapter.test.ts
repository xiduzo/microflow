import { describe, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { FlowDocument } from "@microflow/collab";
import { IndexeddbSyncAdapter } from "./indexeddb-sync-adapter";

/** A fresh IndexedDB store per test, so cases cannot leak into each other. */
let storeCounter = 0;
const freshStore = () => `test-flow-${++storeCounter}`;

const mkNode = (id: string) => ({
  id,
  type: "Led",
  position: { x: 0, y: 0 },
  data: { label: "LED" },
});

/** Let the persistence take its write turn before tearing down. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("IndexeddbSyncAdapter", () => {
  test("persists the document and restores it into a fresh doc", async () => {
    const store = freshStore();

    const first = FlowDocument.createEmpty();
    const a = new IndexeddbSyncAdapter(first, store);
    await a.whenSynced;
    first.addNode(mkNode("n1"));
    await settle();
    a.destroy();

    const second = FlowDocument.createEmpty();
    const b = new IndexeddbSyncAdapter(second, store);
    await b.whenSynced;

    expect(second.getNodes().map((n) => n.id)).toEqual(["n1"]);
    expect(second.getNode("n1")!.data).toEqual({ label: "LED" });
    b.destroy();
  });

  test("brings a document stored in the pre-ADR-0017 shape forward on load", async () => {
    const store = freshStore();

    // Seed IndexedDB with a flat node, as a build before the nested shape
    // would have left it.
    const legacy = new Y.Doc();
    legacy.transact(() => {
      legacy.getMap<unknown>("nodes").set("old", mkNode("old"));
    }, "legacy");
    const seedDoc = new FlowDocument(legacy);
    const seed = new IndexeddbSyncAdapter(seedDoc, store);
    await seed.whenSynced;
    await settle();
    seed.destroy();

    const doc = FlowDocument.createEmpty();
    const adapter = new IndexeddbSyncAdapter(doc, store);
    await adapter.whenSynced;

    // Readable through the normal path, with no compatibility branch in it.
    expect(doc.getNode("old")!.data).toEqual({ label: "LED" });
    expect(doc.nodes.get("old")).toBeInstanceOf(Y.Map);
    adapter.destroy();
  });

  test("kind is local and destroy is idempotent", async () => {
    const doc = FlowDocument.createEmpty();
    const adapter = new IndexeddbSyncAdapter(doc, freshStore());
    await adapter.whenSynced;

    expect(adapter.kind).toBe("local");
    adapter.destroy();
    expect(() => adapter.destroy()).not.toThrow();
  });
});
