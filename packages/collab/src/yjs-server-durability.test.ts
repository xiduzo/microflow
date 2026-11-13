import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

import { RoomGone, RoomServerShuttingDown, YjsServer, type Connection } from "./yjs-server";
import { MemoryRoomStore, type RoomStore } from "./room-store";
import { CLOSE_SERVICE_RESTART } from "./protocol";

/**
 * Room durability: an edit the room accepted must reach the store. These
 * tests drive the room through `RoomConnection` handles with
 * `MemoryRoomStore` as the persistence adapter.
 */

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
    const server = new YjsServer({ store, persistDebounce: 5, persistMaxWait: 10_000 });

    const connection = await server.join("flow-offline", socket(), "user-a", true);
    connection.receive(syncStep2Message((doc) => doc.getMap("nodes").set("n1", "offline")));

    await Bun.sleep(30);

    expect(store.saves.length).toBe(1);
    expect(persisted(store.saves[0]!.state).getMap("nodes").get("n1")).toBe("offline");
  });

  test("a step 2 that brings nothing new does not persist", async () => {
    const store = new MemoryRoomStore();
    const server = new YjsServer({ store, persistDebounce: 5, persistMaxWait: 10_000 });

    const connection = await server.join("flow-noop", socket(), "user-a", true);
    connection.receive(syncStep2Message(() => {}));

    await Bun.sleep(30);

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
  /** When each failed save happened, to measure the backoff between them. */
  readonly failedAt: number[] = [];

  constructor(seed?: Record<string, Uint8Array>) {
    this.inner = new MemoryRoomStore(seed);
  }

  get failedSaves(): number {
    return this.failedAt.length;
  }

  load(flowId: string): Promise<Uint8Array | null> {
    return this.inner.load(flowId);
  }

  save(flowId: string, state: Uint8Array): Promise<void> {
    if (this.failing) {
      this.failedAt.push(performance.now());
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
    const server = new YjsServer({ store, persistDebounce: 1, persistRetryBase: 5 });

    const connection = await server.join("flow-retry", socket(), "user-a", true);
    connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", 1)));

    // Failing saves at ~1ms, ~6ms, ~16ms (backoff 5, 10, ...).
    await Bun.sleep(20);
    expect(store.failedSaves).toBeGreaterThanOrEqual(2);
    expect(store.inner.saves.length).toBe(0);

    store.failing = false;
    await Bun.sleep(60);

    expect(store.inner.saves.length).toBe(1);
    expect(nodesOf(store.inner.saves[0]!.state).get("n1")).toBe(1);
    await settle(server);
  });

  test("the delay between retries doubles, up to the cap", async () => {
    const store = new FailingRoomStore();
    const server = new YjsServer({
      store,
      persistDebounce: 1,
      persistRetryBase: 10,
      persistRetryMax: 40,
    });

    const connection = await server.join("flow-backoff", socket(), "user-a", true);
    connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", 1)));

    // Saves at ~1, 11, 31, 71, 111ms: gaps 10, 20, 40, then capped at 40.
    await Bun.sleep(130);
    const gaps = store.failedAt.slice(1).map((t, i) => t - store.failedAt[i]!);
    expect(gaps.length).toBeGreaterThanOrEqual(4);
    expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.5);
    expect(gaps[2]!).toBeGreaterThan(gaps[1]! * 1.5);
    // Capped: the fourth wait is no longer than the third (timer slack aside).
    expect(gaps[3]!).toBeLessThan(gaps[2]! * 1.5);

    await settle(server, store);
  });

  test("an idle room whose final save fails is kept, not destroyed", async () => {
    const store = new FailingRoomStore();
    const server = new YjsServer({ store, persistDebounce: 60_000, persistRetryBase: 5 });

    const connection = await server.join("flow-keep", socket(), "user-a", true);
    connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", "unsaved")));
    connection.close(); // last one out: final flush, which fails

    await Bun.sleep(20);
    expect(store.failedSaves).toBeGreaterThanOrEqual(1);
    // Still in memory, edit intact.
    expect(server.getRoomCount()).toBe(1);
    expect(nodesOf(server.currentState("flow-keep")).get("n1")).toBe("unsaved");

    // The store recovers: the retry lands and only then is the room released.
    store.failing = false;
    await Bun.sleep(60);
    expect(store.inner.saves.length).toBe(1);
    expect(nodesOf(store.inner.saves[0]!.state).get("n1")).toBe("unsaved");
    expect(server.getRoomCount()).toBe(0);
  });

  test("a join while an unsaved room is held gets its edits, not the older stored copy", async () => {
    const seeded = new Y.Doc();
    seeded.getMap("nodes").set("n0", "stored");
    const store = new FailingRoomStore({ "flow-rejoin": Y.encodeStateAsUpdate(seeded) });
    const server = new YjsServer({ store, persistDebounce: 60_000, persistRetryBase: 1_000 });

    const first = await server.join("flow-rejoin", socket(), "user-a", true);
    first.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", "unsaved")));
    first.close();
    await Bun.sleep(5);

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
    expect(Date.now() - started).toBeLessThan(500);
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
