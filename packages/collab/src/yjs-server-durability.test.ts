import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

import { RoomGone, RoomServerShuttingDown, YjsServer, type Connection } from "./yjs-server";
import { MemoryRoomStore, mergeDocumentStates, type RoomStore } from "./room-store";
import { CLOSE_SERVICE_RESTART } from "./protocol";
import { ManualClock } from "./manual-clock";

/**
 * Room durability: an edit the room accepted must reach the store. These
 * tests drive the room through `RoomConnection` handles with
 * `MemoryRoomStore` as the persistence adapter.
 *
 * Debounce, ceiling and backoff run on a `ManualClock`: the tests step time
 * and assert exact delays rather than sleeping and hoping the machine kept
 * up. Only `shutdown()` deadlines still use real time.
 */

// Failed saves are logged loudly by design; here they are expected. Silence
// them (the cost of printing stacks also skewed timing before the clock seam).
let consoleError: ReturnType<typeof spyOn>;
beforeEach(() => {
  consoleError = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
});

const MESSAGE_SYNC = 0;

/**
 * What a reconnecting client sends with its offline edits: sync step 2, the
 * answer to the server's step-1 state-vector request. Not an `update` frame.
 */
function syncStep2Message(mutate: (doc: Y.Doc) => void): Uint8Array {
  const client = new Y.Doc();
  mutate(client);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep2(encoder, client);
  return encoding.toUint8Array(encoder);
}

function socket(): Connection {
  return { send: () => {}, close: () => {} };
}

function persisted(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

describe("YjsServer durability: sync step 2", () => {
  test("offline edits sent as sync step 2 are persisted", async () => {
    const store = new MemoryRoomStore();
    const clock = new ManualClock();
    const server = new YjsServer({ store, persistDebounce: 5, persistClock: clock });

    const connection = await server.join("flow-offline", socket(), "user-a", true);
    connection.receive(syncStep2Message((doc) => doc.getMap("nodes").set("n1", "offline")));

    await clock.advance(5);

    expect(store.saves.length).toBe(1);
    expect(persisted(store.saves[0]!.state).getMap("nodes").get("n1")).toBe("offline");
  });

  test("a step 2 that brings nothing new does not persist", async () => {
    const store = new MemoryRoomStore();
    const clock = new ManualClock();
    const server = new YjsServer({ store, persistDebounce: 5, persistClock: clock });

    const connection = await server.join("flow-noop", socket(), "user-a", true);
    connection.receive(syncStep2Message(() => {}));

    // Nothing changed, so nothing was even scheduled.
    expect(clock.pendingCount).toBe(0);
    await clock.advance(60_000);

    expect(store.saves.length).toBe(0);
  });
});

/**
 * A `RoomStore` adapter whose saves fail while `failing` is set — the store
 * being down mid-session. Loads always work; it wraps `MemoryRoomStore`.
 */
class FailingRoomStore implements RoomStore {
  readonly inner: MemoryRoomStore;
  failing = true;
  failedSaves = 0;

  constructor(seed?: Record<string, Uint8Array>) {
    this.inner = new MemoryRoomStore(seed);
  }

  load(flowId: string): Promise<Uint8Array | null> {
    return this.inner.load(flowId);
  }

  save(flowId: string, state: Uint8Array): Promise<void> {
    if (this.failing) {
      this.failedSaves++;
      return Promise.reject(new Error("store unavailable"));
    }
    return this.inner.save(flowId, state);
  }
}

/** A `RoomStore` whose loads block until the test opens the gate. */
class GatedRoomStore extends MemoryRoomStore {
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  override async load(flowId: string): Promise<Uint8Array | null> {
    await this.gate;
    return super.load(flowId);
  }

  open(): void {
    this.release();
  }
}

/**
 * Let a test's held rooms finish: recover the store and drain, so no backoff
 * retry outlives the test and logs into the next one.
 */
async function settle(server: YjsServer, store?: FailingRoomStore): Promise<void> {
  if (store) store.failing = false;
  await server.shutdown(1_000);
}

function updateMessage(mutate: (doc: Y.Doc) => void): Uint8Array {
  const client = new Y.Doc();
  mutate(client);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client));
  return encoding.toUint8Array(encoder);
}

function nodesOf(state: Uint8Array | null): Y.Map<unknown> {
  if (!state) throw new Error("expected a document state");
  return persisted(state).getMap("nodes");
}

describe("YjsServer durability: failed saves", () => {
  test("a failed save is retried with backoff without waiting for another edit", async () => {
    const store = new FailingRoomStore();
    const clock = new ManualClock();
    const server = new YjsServer({
      store,
      persistDebounce: 1,
      persistRetryBase: 5,
      persistClock: clock,
    });

    const connection = await server.join("flow-retry", socket(), "user-a", true);
    connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", 1)));

    await clock.advance(1); // debounce: first save, fails
    await clock.advance(5); // first retry, fails
    expect(store.failedSaves).toBe(2);
    expect(store.inner.saves.length).toBe(0);

    // No further edit arrives; the pending retry alone carries the change.
    store.failing = false;
    await clock.advance(10);

    expect(store.inner.saves.length).toBe(1);
    expect(nodesOf(store.inner.saves[0]!.state).get("n1")).toBe(1);
    expect(clock.pendingCount).toBe(0);
    await settle(server);
  });

  test("the delay between retries doubles, up to the cap", async () => {
    const store = new FailingRoomStore();
    const clock = new ManualClock();
    const server = new YjsServer({
      store,
      persistDebounce: 1,
      persistRetryBase: 10,
      persistRetryMax: 40,
      persistClock: clock,
    });

    const connection = await server.join("flow-backoff", socket(), "user-a", true);
    connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", 1)));

    // Debounce, then one save attempt per timer: each failure arms the next wait.
    const waited: Array<number | null> = [];
    for (let i = 0; i < 6; i++) waited.push(await clock.runNext());

    expect(waited).toEqual([1, 10, 20, 40, 40, 40]);
    expect(store.failedSaves).toBe(6);
    // Every failure is still reported loudly, with its attempt number.
    expect(consoleError).toHaveBeenCalledTimes(6);
    expect(String(consoleError.mock.calls[5]![0])).toContain("attempt 6");

    await settle(server, store);
  });

  test("an idle room whose final save fails is kept, not destroyed", async () => {
    const store = new FailingRoomStore();
    const clock = new ManualClock();
    const server = new YjsServer({
      store,
      persistDebounce: 60_000,
      persistRetryBase: 5,
      persistClock: clock,
    });

    const connection = await server.join("flow-keep", socket(), "user-a", true);
    connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", "unsaved")));
    connection.close(); // last one out: final flush, which fails

    await clock.advance(5); // and its first retry fails too
    expect(store.failedSaves).toBe(2);
    // Still in memory, edit intact.
    expect(server.getRoomCount()).toBe(1);
    expect(nodesOf(server.currentState("flow-keep")).get("n1")).toBe("unsaved");

    // The store recovers: the retry lands and only then is the room released.
    store.failing = false;
    await clock.runNext();
    expect(store.inner.saves.length).toBe(1);
    expect(nodesOf(store.inner.saves[0]!.state).get("n1")).toBe("unsaved");
    expect(server.getRoomCount()).toBe(0);
  });

  test("a join while an unsaved room is held gets its edits, not the older stored copy", async () => {
    const seeded = new Y.Doc();
    seeded.getMap("nodes").set("n0", "stored");
    const store = new FailingRoomStore({ "flow-rejoin": Y.encodeStateAsUpdate(seeded) });
    const clock = new ManualClock();
    const server = new YjsServer({ store, persistDebounce: 60_000, persistClock: clock });

    const first = await server.join("flow-rejoin", socket(), "user-a", true);
    first.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", "unsaved")));
    first.close();
    await clock.advance(0); // the final flush fails; the room is held
    expect(store.failedSaves).toBe(1);

    await server.join("flow-rejoin", socket(), "user-b", true);
    const nodes = nodesOf(server.currentState("flow-rejoin"));
    expect(nodes.get("n0")).toBe("stored");
    expect(nodes.get("n1")).toBe("unsaved");
    await settle(server, store);
  });
});

describe("YjsServer durability: readers", () => {
  test("currentState is the live document, ahead of the debounced store", async () => {
    const store = new MemoryRoomStore();
    const server = new YjsServer({ store, persistDebounce: 60_000 });

    expect(server.currentState("flow-live")).toBeNull();

    const connection = await server.join("flow-live", socket(), "user-a", true);
    connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", "live")));

    expect(store.saves.length).toBe(0);
    expect(nodesOf(server.currentState("flow-live")).get("n1")).toBe("live");
    await settle(server);
  });
});

describe("YjsServer durability: shutdown", () => {
  test("shutdown closes every socket as a restart and persists dirty rooms", async () => {
    const store = new MemoryRoomStore();
    // A debounce longer than any deploy grace period: only shutdown can save.
    const server = new YjsServer({ store, persistDebounce: 60_000 });

    const closes: Array<number | undefined> = [];
    const connection = await server.join(
      "flow-exit",
      { send: () => {}, close: (code) => closes.push(code) },
      "user-a",
      true,
    );
    connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", "before exit")));

    const result = await server.shutdown(1_000);

    expect(result.unsaved).toEqual([]);
    expect(closes).toEqual([CLOSE_SERVICE_RESTART]);
    expect(store.saves.length).toBe(1);
    expect(nodesOf(store.saves[0]!.state).get("n1")).toBe("before exit");
    expect(server.getRoomCount()).toBe(0);

    // No new room may open behind the final write.
    await expect(server.join("flow-exit", socket(), "user-a", true)).rejects.toBeInstanceOf(
      RoomServerShuttingDown,
    );
  });

  test("shutdown retries a failing store until it recovers within the timeout", async () => {
    const store = new FailingRoomStore();
    const server = new YjsServer({ store, persistDebounce: 60_000, persistRetryBase: 5 });

    const connection = await server.join("flow-exit-retry", socket(), "user-a", true);
    connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", 1)));

    setTimeout(() => (store.failing = false), 100);
    const result = await server.shutdown(2_000);

    expect(result.unsaved).toEqual([]);
    expect(store.inner.saves.length).toBe(1);
  });

  test("shutdown reports rooms it could not persist before the timeout", async () => {
    const store = new FailingRoomStore();
    const server = new YjsServer({ store, persistDebounce: 60_000, persistRetryBase: 5 });

    const connection = await server.join("flow-exit-lost", socket(), "user-a", true);
    connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", 1)));

    const started = Date.now();
    const result = await server.shutdown(100);

    expect(result.unsaved).toEqual(["flow-exit-lost"]);
    // Bounded by the timeout, not by the store: generous, as this is real time.
    expect(Date.now() - started).toBeLessThan(2_000);
    await settle(server, store);
  });

  test("a join still loading when shutdown starts leaves no room behind", async () => {
    const store = new GatedRoomStore();
    const server = new YjsServer({ store, persistDebounce: 60_000 });

    const joining = server.join("flow-late", socket(), "user-a", true);
    const draining = server.shutdown(1_000);
    store.open();

    await expect(joining).rejects.toBeInstanceOf(RoomServerShuttingDown);
    expect(await draining).toEqual({ unsaved: [] });
    // Registered after the drain's snapshot, this room would never be drained.
    expect(server.getRoomCount()).toBe(0);
  });
});

describe("RoomStore durability: saves merge", () => {
  test("an old instance's late save does not erase edits made on the new one", async () => {
    const store = new MemoryRoomStore();
    // An overlapping deploy: two instances each hold a room for one flow.
    const oldInstance = new YjsServer({ store, persistDebounce: 60_000 });
    const newInstance = new YjsServer({ store, persistDebounce: 60_000 });

    const before = await oldInstance.join("flow-deploy", socket(), "user-a", true);
    const after = await newInstance.join("flow-deploy", socket(), "user-b", true);
    before.receive(updateMessage((doc) => doc.getMap("nodes").set("old", "before deploy")));
    after.receive(updateMessage((doc) => doc.getMap("nodes").set("new", "after deploy")));

    // The new instance saves first; the old one's drain lands afterwards.
    await newInstance.shutdown(1_000);
    await oldInstance.shutdown(1_000);

    const nodes = nodesOf(await store.load("flow-deploy"));
    expect(nodes.get("new")).toBe("after deploy");
    expect(nodes.get("old")).toBe("before deploy");
  });

  test("a stale save cannot resurrect content deleted since", () => {
    const shared = new Y.Doc();
    shared.getMap("nodes").set("doomed", "x".repeat(1_000));
    const stale = Y.encodeStateAsUpdate(shared);
    shared.getMap("nodes").delete("doomed");
    const fresh = Y.encodeStateAsUpdate(shared);

    for (const merged of [mergeDocumentStates(fresh, stale), mergeDocumentStates(stale, fresh)]) {
      expect(nodesOf(merged).has("doomed")).toBe(false);
      // Deleted content is collected, not carried forward from the stale side.
      expect(merged.byteLength).toBeLessThan(stale.byteLength);
    }
  });
});

describe("YjsServer durability: deleted flows", () => {
  test("a join still loading when the flow is dropped does not recreate it", async () => {
    const store = new GatedRoomStore();
    const server = new YjsServer({ store, persistDebounce: 5 });

    const joining = server.join("flow-deleted", socket(), "user-a", true);
    server.dropRoom("flow-deleted");
    store.open();

    await expect(joining).rejects.toBeInstanceOf(RoomGone);
    expect(server.getRoomCount()).toBe(0);
    expect(store.saves.length).toBe(0);
  });

  test("a join racing the drop of a live room does not reload it", async () => {
    const store = new MemoryRoomStore();
    const server = new YjsServer({ store, persistDebounce: 60_000 });
    await server.join("flow-deleted-live", socket(), "user-a", true);

    // The join finds the live room, then the drop lands before it attaches.
    const joining = server.join("flow-deleted-live", socket(), "user-b", true);
    server.dropRoom("flow-deleted-live");

    await expect(joining).rejects.toBeInstanceOf(RoomGone);
    expect(server.getRoomCount()).toBe(0);
    expect(store.saves.length).toBe(0);
  });
});
