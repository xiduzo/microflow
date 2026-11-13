import { describe, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { FlowDocument } from "@microflow/collab";
import { configureErrorReporting, type LocalErrorReport } from "@/lib/report-error";
import { IndexeddbSyncAdapter, LocalPersistenceError, PROBE_DB } from "./indexeddb-sync-adapter";

/** Replace the global `indexedDB` (installed by fake-indexeddb) for one test. */
function swapIndexedDb(replacement: unknown): () => void {
  const scope = globalThis as { indexedDB?: unknown };
  const original = scope.indexedDB;
  scope.indexedDB = replacement;
  return () => {
    scope.indexedDB = original;
  };
}

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

  test("brings a document stored in the pre-ADR-0019 shape forward on load", async () => {
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

  test("whenSynced rejects with open-failed when IndexedDB will not open", async () => {
    const reports: LocalErrorReport[] = [];
    const restoreReporting = configureErrorReporting({ local: [(r) => reports.push(r)], remote: [] });
    // An `indexedDB` whose open fails the way private mode or blocked site data does.
    const denied = new DOMException("denied", "UnknownError");
    const restoreIdb = swapIndexedDb({
      open() {
        const request: { error?: DOMException; onerror?: () => void } = {};
        setTimeout(() => {
          request.error = denied;
          request.onerror?.();
        });
        return request;
      },
    });
    try {
      const adapter = new IndexeddbSyncAdapter(FlowDocument.createEmpty(), freshStore());
      const error = await adapter.whenSynced.then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(LocalPersistenceError);
      expect(error).toMatchObject({ reason: "open-failed", cause: denied });
      expect(adapter.error).toBe(error as LocalPersistenceError);
      // Learned about even though the editor never awaits `whenSynced`.
      expect(reports.map((r) => [r.source, r.name])).toEqual([["local-persistence", "LocalPersistenceError"]]);
      expect(() => adapter.destroy()).not.toThrow();
    } finally {
      restoreIdb();
      restoreReporting();
    }
  });

  test("whenSynced rejects with open-failed when there is no IndexedDB at all", async () => {
    const restoreReporting = configureErrorReporting({ local: [], remote: [] });
    const restoreIdb = swapIndexedDb(undefined);
    try {
      const adapter = new IndexeddbSyncAdapter(FlowDocument.createEmpty(), freshStore());
      await expect(adapter.whenSynced).rejects.toMatchObject({ reason: "open-failed" });
      adapter.destroy();
    } finally {
      restoreIdb();
      restoreReporting();
    }
  });

  test("a load that never completes: whenSynced times out, reported only once confirmed at destroy", async () => {
    const reports: LocalErrorReport[] = [];
    const restoreReporting = configureErrorReporting({ local: [(r) => reports.push(r)], remote: [] });
    // A blocked open: no success, no error, ever.
    const restoreIdb = swapIndexedDb({ open: () => ({}) });
    try {
      const adapter = new IndexeddbSyncAdapter(FlowDocument.createEmpty(), freshStore(), {
        syncTimeoutMs: 20,
      });
      await expect(adapter.whenSynced).rejects.toMatchObject({ reason: "timeout" });
      expect(adapter.state).toBe("stalled");
      expect(adapter.error?.reason).toBe("timeout");
      // Not confirmed yet: it may still load.
      expect(reports).toEqual([]);

      adapter.destroy();
      // It never loaded in the adapter's lifetime: now it is a failure.
      expect(reports.map((r) => [r.source, r.name])).toEqual([["local-persistence", "LocalPersistenceError"]]);
      expect((reports[0]!.error as LocalPersistenceError).reason).toBe("timeout");
    } finally {
      restoreIdb();
      restoreReporting();
    }
  });

  test("a probe that answers after the timeout still attaches, syncs, and clears the error", async () => {
    const reports: LocalErrorReport[] = [];
    const restoreReporting = configureErrorReporting({ local: [(r) => reports.push(r)], remote: [] });
    // The real (fake-indexeddb) factory, except the probe's open answers late.
    const real = (globalThis as { indexedDB: IDBFactory }).indexedDB;
    const slowProbe = new Proxy(real, {
      get(target, key) {
        if (key !== "open") return Reflect.get(target, key, target);
        return (name: string, version?: number) => {
          if (name !== PROBE_DB) return target.open(name, version);
          const late: { result?: { close(): void }; onsuccess?: () => void } = {};
          setTimeout(() => {
            late.result = { close() {} };
            late.onsuccess?.();
          }, 60);
          return late;
        };
      },
    });
    const restoreIdb = swapIndexedDb(slowProbe);
    const store = freshStore();
    try {
      const doc = FlowDocument.createEmpty();
      const adapter = new IndexeddbSyncAdapter(doc, store, { syncTimeoutMs: 20 });
      const states: string[] = [];
      adapter.onStateChange((s) => states.push(s));

      await expect(adapter.whenSynced).rejects.toMatchObject({ reason: "timeout" });
      // Edits made while stalled must still reach the store.
      doc.addNode(mkNode("late"));

      const synced = new Promise<void>((resolve) => {
        adapter.onStateChange((s) => s === "synced" && resolve());
      });
      await synced;
      expect(states).toEqual(["stalled", "synced"]);
      expect(adapter.error).toBeNull();
      await settle();
      adapter.destroy();
      // Recovered: nothing to report.
      expect(reports).toEqual([]);
    } finally {
      restoreIdb();
      restoreReporting();
    }

    const reopened = FlowDocument.createEmpty();
    const check = new IndexeddbSyncAdapter(reopened, store);
    await check.whenSynced;
    expect(reopened.getNodes().map((n) => n.id)).toEqual(["late"]);
    check.destroy();
  });

  test("destroy before the load settles whenSynced instead of leaving it pending", async () => {
    const reports: LocalErrorReport[] = [];
    const restoreReporting = configureErrorReporting({ local: [(r) => reports.push(r)], remote: [] });
    try {
      const adapter = new IndexeddbSyncAdapter(FlowDocument.createEmpty(), freshStore());
      adapter.destroy();
      await expect(adapter.whenSynced).rejects.toMatchObject({ reason: "destroyed" });
      await settle();
      // Closing early is not a failure worth reporting.
      expect(reports).toEqual([]);
    } finally {
      restoreReporting();
    }
  });

  test("a successful load leaves no error", async () => {
    const adapter = new IndexeddbSyncAdapter(FlowDocument.createEmpty(), freshStore());
    await adapter.whenSynced;
    expect(adapter.error).toBeNull();
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
