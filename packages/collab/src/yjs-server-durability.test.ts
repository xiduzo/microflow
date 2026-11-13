import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

import { YjsServer, type Connection } from "./yjs-server";
import { MemoryRoomStore } from "./room-store";

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
