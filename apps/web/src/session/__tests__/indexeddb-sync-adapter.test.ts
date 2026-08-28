import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { FlowDocument } from "@microflow/collab";
import { IndexeddbSyncAdapter } from "../indexeddb-sync-adapter";

const LEGACY_KEY = "microflow-local-flow";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

/** A fresh IndexedDB store per test, so cases cannot leak into each other. */
let storeCounter = 0;
const freshStore = () => `test-flow-${++storeCounter}`;

beforeEach(() => {
  (globalThis as { localStorage: Storage }).localStorage = new MemoryStorage();
});

afterEach(() => {
  localStorage.clear();
});

const mkNode = (id: string) => ({
  id,
  type: "Led",
  position: { x: 0, y: 0 },
  data: {},
});

describe("IndexeddbSyncAdapter", () => {
  test("persists the document and restores it into a fresh doc", async () => {
    const store = freshStore();

    const first = FlowDocument.createEmpty();
    const a = new IndexeddbSyncAdapter(first, store);
    await a.whenSynced;
    first.addNode(mkNode("n1"));
    // Give the persistence its write turn before tearing down.
    await new Promise((r) => setTimeout(r, 50));
    a.destroy();

    const second = FlowDocument.createEmpty();
    const b = new IndexeddbSyncAdapter(second, store);
    await b.whenSynced;

    expect(second.getNodes().map((n) => n.id)).toEqual(["n1"]);
    b.destroy();
  });

  test("imports a flow left by the previous localStorage adapter", async () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ nodes: [mkNode("legacy-1")], edges: [] }),
    );

    const doc = FlowDocument.createEmpty();
    const adapter = new IndexeddbSyncAdapter(doc, freshStore());
    await adapter.whenSynced;

    expect(doc.getNodes().map((n) => n.id)).toEqual(["legacy-1"]);
    adapter.destroy();
  });

  test("the legacy key is left in place so a rollback still finds the flow", async () => {
    const payload = JSON.stringify({ nodes: [mkNode("legacy-1")], edges: [] });
    localStorage.setItem(LEGACY_KEY, payload);

    const doc = FlowDocument.createEmpty();
    const adapter = new IndexeddbSyncAdapter(doc, freshStore());
    await adapter.whenSynced;

    expect(localStorage.getItem(LEGACY_KEY)).toBe(payload);
    adapter.destroy();
  });

  test("a stale legacy payload never clobbers a stored document", async () => {
    const store = freshStore();

    const first = FlowDocument.createEmpty();
    const a = new IndexeddbSyncAdapter(first, store);
    await a.whenSynced;
    first.addNode(mkNode("current"));
    await new Promise((r) => setTimeout(r, 50));
    a.destroy();

    // An old snapshot is still sitting in localStorage from before the swap.
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ nodes: [mkNode("ancient")], edges: [] }),
    );

    const second = FlowDocument.createEmpty();
    const b = new IndexeddbSyncAdapter(second, store);
    await b.whenSynced;

    // IndexedDB is authoritative once it holds anything.
    expect(second.getNodes().map((n) => n.id)).toEqual(["current"]);
    b.destroy();
  });

  test("the imported flow is not on the undo stack", async () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ nodes: [mkNode("legacy-1")], edges: [] }),
    );

    const doc = FlowDocument.createEmpty();
    const adapter = new IndexeddbSyncAdapter(doc, freshStore());
    await adapter.whenSynced;

    // A first ctrl-Z after upgrading must not erase the migrated flow.
    doc.undo();
    expect(doc.getNodes().map((n) => n.id)).toEqual(["legacy-1"]);
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
