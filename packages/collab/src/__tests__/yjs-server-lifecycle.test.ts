import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { YjsServer, type Connection, type RoomConnection } from "../yjs-server";
import { MemoryRoomStore, type RoomStore } from "../room-store";

/**
 * Room lifecycle under concurrency — the failure modes that only appear when
 * several contributors act on one flow at the same moment, which is the normal
 * case for a group session and never happens in a single-client test.
 */

const MESSAGE_SYNC = 0;

function updateMessage(mutate: (doc: Y.Doc) => void): Uint8Array {
  const client = new Y.Doc();
  mutate(client);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client));
  return encoding.toUint8Array(encoder);
}

/** A client's "what have you got?" message — the read path. */
function syncStep1Message(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** Replay every sync frame a peer received into a fresh doc. */
function mirror(received: Uint8Array[]): Y.Doc {
  const doc = new Y.Doc();
  for (const message of received) {
    const decoder = decoding.createDecoder(message);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), doc, null);
  }
  return doc;
}

type Peer = {
  connection: RoomConnection;
  received: Uint8Array[];
  closed: boolean;
};

function socketFor(peer: Peer, bufferedAmount?: () => number): Connection {
  return {
    send: (d: Uint8Array) => peer.received.push(d),
    close: () => {
      peer.closed = true;
    },
    ...(bufferedAmount ? { bufferedAmount } : {}),
  };
}

/** A store whose `load` blocks until the test releases it. */
class DeferredStore implements RoomStore {
  private readonly inner = new MemoryRoomStore();
  private release!: () => void;
  readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  loadCalls = 0;

  async load(flowId: string): Promise<Uint8Array | null> {
    this.loadCalls++;
    await this.gate;
    return this.inner.load(flowId);
  }

  save(flowId: string, state: Uint8Array): Promise<void> {
    return this.inner.save(flowId, state);
  }

  open(): void {
    this.release();
  }
}

describe("YjsServer concurrent joins", () => {
  test("two joins racing on one flow share a single room", async () => {
    const store = new DeferredStore();
    const server = new YjsServer({ store, persistDebounce: 60_000 });

    const a: Peer = { received: [], closed: false } as Peer;
    const b: Peer = { received: [], closed: false } as Peer;

    // Both joins start before either can finish loading — the window the
    // in-flight memo exists to close.
    const joins = Promise.all([
      server.join("flow-race", socketFor(a), "user-a", true),
      server.join("flow-race", socketFor(b), "user-b", true),
    ]);
    store.open();
    const [ca, cb] = await joins;
    a.connection = ca;
    b.connection = cb;

    expect(server.getRoomCount()).toBe(1);
    expect(server.getConnectionCount("flow-race")).toBe(2);
    // The document is loaded once, not once per racing join.
    expect(store.loadCalls).toBe(1);
  });

  test("a racing joiner's writes reach the other peer", async () => {
    const store = new DeferredStore();
    const server = new YjsServer({ store, persistDebounce: 60_000 });

    const a: Peer = { received: [], closed: false } as Peer;
    const b: Peer = { received: [], closed: false } as Peer;

    const joins = Promise.all([
      server.join("flow-race", socketFor(a), "user-a", true),
      server.join("flow-race", socketFor(b), "user-b", true),
    ]);
    store.open();
    const [ca, cb] = await joins;
    a.connection = ca;
    b.connection = cb;

    // Before the fix the loser of the `rooms.set` race was registered in an
    // orphaned room: its `receive` found the surviving room, saw itself absent
    // from `connections`, and returned without applying or broadcasting.
    a.received.length = 0;
    b.received.length = 0;
    a.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", "from-a")));

    expect(mirror(b.received).getMap("nodes").get("n1")).toBe("from-a");

    b.received.length = 0;
    b.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n2", "from-b")));

    expect(mirror(a.received).getMap("nodes").get("n2")).toBe("from-b");
  });

  test("a join arriving during teardown sees the state the last session flushed", async () => {
    const store = new MemoryRoomStore();
    const server = new YjsServer({ store, persistDebounce: 60_000 });

    const first: Peer = { received: [], closed: false } as Peer;
    first.connection = await server.join("flow-churn", socketFor(first), "user-a", true);
    first.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", "written")));

    // Last disconnect starts a teardown that persists before destroying; the
    // next joiner must read the flushed state, not the state before it.
    first.connection.close();
    const second: Peer = { received: [], closed: false } as Peer;
    second.connection = await server.join("flow-churn", socketFor(second), "user-b", true);

    // Ask the room for its state the way a real client does — `join` only
    // sends a state-vector request, the content comes back in step 2.
    second.connection.receive(syncStep1Message(new Y.Doc()));
    expect(mirror(second.received).getMap("nodes").get("n1")).toBe("written");
    expect(server.getRoomCount()).toBe(1);
  });
});

describe("YjsServer persist ceiling", () => {
  test("continuous edits still persist once the max wait elapses", async () => {
    const store = new MemoryRoomStore();
    // Debounce longer than the ceiling: without a ceiling the timer re-arms on
    // every edit and the room is never written.
    const server = new YjsServer({ store, persistDebounce: 10_000, persistMaxWait: 20 });

    const peer: Peer = { received: [], closed: false } as Peer;
    peer.connection = await server.join("flow-busy", socketFor(peer), "user-a", true);

    peer.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", 1)));
    expect(store.saves.length).toBe(0);

    await new Promise((r) => setTimeout(r, 30));

    // The next edit after the ceiling forces the write rather than re-arming.
    peer.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n2", 2)));
    await new Promise((r) => setTimeout(r, 5));

    expect(store.saves.length).toBe(1);
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, store.saves[0]!.state);
    expect(persisted.getMap("nodes").get("n1")).toBe(1);
    expect(persisted.getMap("nodes").get("n2")).toBe(2);
  });

  test("a failed persist leaves the room dirty so the next attempt retries", async () => {
    let failNext = true;
    const inner = new MemoryRoomStore();
    const store: RoomStore = {
      load: (flowId) => inner.load(flowId),
      save: (flowId, state) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("store unavailable"));
        }
        return inner.save(flowId, state);
      },
    };
    const server = new YjsServer({ store, persistDebounce: 5, persistMaxWait: 10_000 });

    const peer: Peer = { received: [], closed: false } as Peer;
    peer.connection = await server.join("flow-flaky", socketFor(peer), "user-a", true);

    peer.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", 1)));
    await new Promise((r) => setTimeout(r, 20));
    expect(inner.saves.length).toBe(0);

    peer.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n2", 2)));
    await new Promise((r) => setTimeout(r, 20));

    // The retry carries both edits — the first was never dropped.
    expect(inner.saves.length).toBe(1);
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, inner.saves[0]!.state);
    expect(persisted.getMap("nodes").get("n1")).toBe(1);
  });
});

describe("YjsServer connection limits", () => {
  test("a peer whose send buffer is over the limit is dropped, not buffered", async () => {
    const store = new MemoryRoomStore();
    const server = new YjsServer({ store, persistDebounce: 60_000, maxBufferedBytes: 100 });

    const writer: Peer = { received: [], closed: false } as Peer;
    const stalled: Peer = { received: [], closed: false } as Peer;
    const healthy: Peer = { received: [], closed: false } as Peer;

    writer.connection = await server.join("flow-slow", socketFor(writer), "user-w", true);
    stalled.connection = await server.join("flow-slow", socketFor(stalled, () => 5_000), "user-s", true);
    healthy.connection = await server.join("flow-slow", socketFor(healthy, () => 0), "user-h", true);

    stalled.received.length = 0;
    healthy.received.length = 0;
    writer.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("n1", 1)));

    expect(stalled.received.length).toBe(0);
    expect(stalled.closed).toBe(true);
    expect(server.getConnectionCount("flow-slow")).toBe(2);
    // The healthy peer is unaffected by its neighbour being dropped.
    expect(mirror(healthy.received).getMap("nodes").get("n1")).toBe(1);
  });

  test("a frame over the size cap is dropped without reaching the doc", async () => {
    const store = new MemoryRoomStore();
    const maxMessageBytes = 200;
    const server = new YjsServer({ store, persistDebounce: 60_000, maxMessageBytes });

    const peer: Peer = { received: [], closed: false } as Peer;
    peer.connection = await server.join("flow-big", socketFor(peer), "user-a", true);

    const big = updateMessage((doc) => doc.getMap("nodes").set("n1", "x".repeat(500)));
    const small = updateMessage((doc) => doc.getMap("nodes").set("s", 1));
    // The cap has to actually separate the two, or the test proves nothing.
    expect(big.byteLength).toBeGreaterThan(maxMessageBytes);
    expect(small.byteLength).toBeLessThanOrEqual(maxMessageBytes);
    peer.connection.receive(big);

    // Read the room back through the peer itself: joining a second observer
    // only yields a state-vector request, so asserting on its inbox alone
    // would hold whether or not the write landed.
    peer.received.length = 0;
    peer.connection.receive(syncStep1Message(new Y.Doc()));
    expect(mirror(peer.received).getMap("nodes").get("n1")).toBeUndefined();

    // A frame under the cap on the same connection still applies, so the
    // assertion above is about the size check and not a dead connection.
    peer.connection.receive(small);
    peer.received.length = 0;
    peer.connection.receive(syncStep1Message(new Y.Doc()));
    expect(mirror(peer.received).getMap("nodes").get("s")).toBe(1);
  });

  test("a flooding connection is throttled once its bucket empties", async () => {
    const store = new MemoryRoomStore();
    const server = new YjsServer({ store, persistDebounce: 60_000, messageRateLimit: 5 });

    const flooder: Peer = { received: [], closed: false } as Peer;
    const observer: Peer = { received: [], closed: false } as Peer;
    flooder.connection = await server.join("flow-flood", socketFor(flooder), "user-a", true);
    observer.connection = await server.join("flow-flood", socketFor(observer), "user-b", true);

    observer.received.length = 0;
    for (let i = 0; i < 50; i++) {
      flooder.connection.receive(updateMessage((doc) => doc.getMap("nodes").set(`n${i}`, i)));
    }

    const seen = mirror(observer.received).getMap("nodes").size;
    // The bucket starts full at 5 and refills negligibly within the loop.
    expect(seen).toBeLessThanOrEqual(6);
    expect(seen).toBeGreaterThan(0);
  });
});
