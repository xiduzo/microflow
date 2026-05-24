import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FlowDocument } from "@microflow/collab";
import { LocalStorageSyncAdapter } from "../local-storage-sync-adapter";

const KEY = "microflow-local-flow";

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

beforeEach(() => {
  (globalThis as { localStorage: Storage }).localStorage = new MemoryStorage();
});

afterEach(() => {
  localStorage.clear();
});

describe("LocalStorageSyncAdapter", () => {
  test("hydrates doc from existing localStorage payload", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        nodes: [{ id: "n1", type: "Led", position: { x: 0, y: 0 }, data: {} }],
        edges: [],
      }),
    );

    const doc = FlowDocument.createEmpty();
    const adapter = new LocalStorageSyncAdapter(doc);

    expect(doc.getNodes()).toHaveLength(1);
    expect(doc.getNodes()[0]!.id).toBe("n1");
    adapter.destroy();
  });

  test("persists doc updates back to localStorage", () => {
    const doc = FlowDocument.createEmpty();
    const adapter = new LocalStorageSyncAdapter(doc);

    doc.addNode({ id: "n1", type: "Led", position: { x: 1, y: 2 }, data: {} });

    const stored = JSON.parse(localStorage.getItem(KEY)!) as {
      nodes: { id: string }[];
    };
    expect(stored.nodes.map((n) => n.id)).toEqual(["n1"]);
    adapter.destroy();
  });

  test("kind is local", () => {
    const adapter = new LocalStorageSyncAdapter(FlowDocument.createEmpty());
    expect(adapter.kind).toBe("local");
    adapter.destroy();
  });

  test("destroy stops further writes", () => {
    const doc = FlowDocument.createEmpty();
    const adapter = new LocalStorageSyncAdapter(doc);
    adapter.destroy();

    const stored = localStorage.getItem(KEY);
    localStorage.setItem("__sentinel", "before");

    doc.addNode({ id: "n2", type: "Led", position: { x: 0, y: 0 }, data: {} });

    expect(localStorage.getItem(KEY)).toBe(stored);
  });

  test("destroy is idempotent", () => {
    const adapter = new LocalStorageSyncAdapter(FlowDocument.createEmpty());
    adapter.destroy();
    expect(() => adapter.destroy()).not.toThrow();
  });
});
