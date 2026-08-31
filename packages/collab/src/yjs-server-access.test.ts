import { beforeEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { YjsServer, type RoomConnection } from "./yjs-server";
import { MemoryRoomStore } from "./room-store";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** A client's "here is my state" message — the write path. */
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

/** A client announcing its presence. */
function awarenessMessage(user: Record<string, unknown>): Uint8Array {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalStateField("user", user);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]),
  );
  return encoding.toUint8Array(encoder);
}

type Peer = {
  connection: RoomConnection;
  received: Uint8Array[];
  closed: boolean;
  /** Replay every sync message received so far into a local mirror doc. */
  mirror(): Y.Doc;
  /** Replay every awareness message received so far. */
  presence(): Map<number, { user?: { id?: string; name?: string } }>;
};

async function connect(
  server: YjsServer,
  flowId: string,
  userId: string,
  canWrite: boolean,
): Promise<Peer> {
  const received: Uint8Array[] = [];
  const peer = { closed: false } as Peer;
  const connection = await server.join(
    flowId,
    { send: (d: Uint8Array) => received.push(d), close: () => (peer.closed = true) },
    userId,
    canWrite,
  );
  peer.connection = connection;
  peer.received = received;
  peer.mirror = () => {
    const doc = new Y.Doc();
    for (const message of received) {
      const decoder = decoding.createDecoder(message);
      if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), doc, null);
    }
    return doc;
  };
  peer.presence = () => {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    for (const message of received) {
      const decoder = decoding.createDecoder(message);
      if (decoding.readVarUint(decoder) !== MESSAGE_AWARENESS) continue;
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        null,
      );
    }
    const states = new Map<number, { user?: { id?: string; name?: string } }>();
    awareness.getStates().forEach((state, clientId) => {
      if (clientId !== doc.clientID) states.set(clientId, state as never);
    });
    return states;
  };
  return peer;
}

/** Ask the room for its state and read the answer back into a fresh doc. */
function readRoom(peer: Peer): Y.Doc {
  peer.connection.receive(syncStep1Message(new Y.Doc()));
  return peer.mirror();
}

describe("YjsServer write authorization", () => {
  let server: YjsServer;
  let store: MemoryRoomStore;

  beforeEach(() => {
    store = new MemoryRoomStore();
    server = new YjsServer({ store, persistDebounce: 60_000 });
  });

  test("an editor connection's update is applied to the room", async () => {
    const editor = await connect(server, "flow-1", "user-1", true);

    editor.connection.receive(
      updateMessage((doc) => doc.getMap("nodes").set("a", "editor-wrote-this")),
    );

    // Reading back through a second connection proves the room doc changed.
    const observer = await connect(server, "flow-1", "user-2", false);
    expect(readRoom(observer).getMap("nodes").get("a")).toBe("editor-wrote-this");
  });

  test("a read-only connection's update is dropped, and it can still read", async () => {
    const editor = await connect(server, "flow-1", "user-1", true);
    editor.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("a", "owned")));

    const viewer = await connect(server, "flow-1", "user-2", false);
    // A distinct key, so this asserts the write was dropped rather than
    // relying on Y.Map's clientID-ordered conflict resolution.
    viewer.connection.receive(
      updateMessage((doc) => doc.getMap("nodes").set("b", "viewer-wrote-this")),
    );

    const mirror = readRoom(viewer);
    expect(mirror.getMap("nodes").has("b")).toBe(false);
    expect(mirror.getMap("nodes").get("a")).toBe("owned");
  });

  test("a closed connection cannot write", async () => {
    const editor = await connect(server, "flow-1", "user-1", true);
    const other = await connect(server, "flow-1", "user-2", true);

    editor.connection.close();
    editor.connection.receive(
      updateMessage((doc) => doc.getMap("nodes").set("b", "after-close")),
    );

    expect(readRoom(other).getMap("nodes").has("b")).toBe(false);
  });

  test("the sender does not receive its own update echoed back", async () => {
    const editor = await connect(server, "flow-1", "user-1", true);
    const before = editor.received.length;

    editor.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("a", "1")));

    expect(editor.received.length).toBe(before);
  });
});

describe("YjsServer.setAccess", () => {
  let server: YjsServer;

  beforeEach(() => {
    server = new YjsServer({ store: new MemoryRoomStore(), persistDebounce: 60_000 });
  });

  test('"read" stops an editor writing mid-session', async () => {
    const editor = await connect(server, "flow-2", "demoted", true);
    editor.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("a", "before")));

    server.setAccess("flow-2", "demoted", "read");
    editor.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("b", "after")));

    const mirror = readRoom(editor);
    expect(mirror.getMap("nodes").get("a")).toBe("before");
    expect(mirror.getMap("nodes").has("b")).toBe(false);
  });

  test('"write" restores a promoted viewer', async () => {
    const viewer = await connect(server, "flow-2", "promoted", false);

    server.setAccess("flow-2", "promoted", "write");
    viewer.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("a", "now-allowed")));

    expect(readRoom(viewer).getMap("nodes").get("a")).toBe("now-allowed");
  });

  test('"none" closes the socket and drops the connection', async () => {
    const removed = await connect(server, "flow-2", "removed", true);
    const stays = await connect(server, "flow-2", "stays", true);

    server.setAccess("flow-2", "removed", "none");

    expect(removed.closed).toBe(true);
    expect(server.getConnectionCount("flow-2")).toBe(1);

    removed.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("x", "ghost")));
    expect(readRoom(stays).getMap("nodes").has("x")).toBe(false);
  });

  test("only the named user is affected", async () => {
    const target = await connect(server, "flow-2", "target", true);
    const bystander = await connect(server, "flow-2", "bystander", true);

    server.setAccess("flow-2", "target", "none");

    expect(bystander.closed).toBe(false);
    bystander.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("a", "fine")));
    expect(readRoom(bystander).getMap("nodes").get("a")).toBe("fine");
    expect(target.closed).toBe(true);
  });
});

describe("YjsServer presence identity", () => {
  let server: YjsServer;

  beforeEach(() => {
    server = new YjsServer({ store: new MemoryRoomStore(), persistDebounce: 60_000 });
  });

  test("user.id is overwritten with the authenticated user", async () => {
    const watcher = await connect(server, "flow-3", "watcher", true);
    const impostor = await connect(server, "flow-3", "real-viewer-id", false);

    impostor.connection.receive(
      awarenessMessage({ id: "the-owners-id", name: "Owner", color: "#000" }),
    );

    const states = Array.from(watcher.presence().values());
    expect(states.length).toBe(1);
    expect(states[0]!.user!.id).toBe("real-viewer-id");
    // Everything else the client said about itself is left alone.
    expect(states[0]!.user!.name).toBe("Owner");
  });

  test("awareness states are removed when the connection closes", async () => {
    const watcher = await connect(server, "flow-3", "watcher", true);
    const peer = await connect(server, "flow-3", "peer", true);

    peer.connection.receive(awarenessMessage({ id: "peer", name: "Peer" }));
    expect(watcher.presence().size).toBe(1);

    peer.connection.close();
    expect(watcher.presence().size).toBe(0);
  });
});

describe("YjsServer persistence", () => {
  test("the room loads from the store and flushes back on the last disconnect", async () => {
    const seeded = new Y.Doc();
    seeded.getMap("nodes").set("seed", "from-store");
    const store = new MemoryRoomStore({ "flow-4": Y.encodeStateAsUpdate(seeded) });
    const server = new YjsServer({ store, persistDebounce: 60_000 });

    const editor = await connect(server, "flow-4", "user-1", true);
    expect(readRoom(editor).getMap("nodes").get("seed")).toBe("from-store");

    editor.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("added", "later")));
    expect(store.saves.length).toBe(0); // debounced, not yet written

    editor.connection.close(); // last connection out → final flush
    await Bun.sleep(0);

    expect(store.saves.length).toBe(1);
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, store.saves[0]!.state);
    expect(persisted.getMap("nodes").get("added")).toBe("later");
    expect(persisted.getMap("nodes").get("seed")).toBe("from-store");
  });

  test("a dropped room is discarded without persisting", async () => {
    const store = new MemoryRoomStore();
    const server = new YjsServer({ store, persistDebounce: 60_000 });

    const editor = await connect(server, "flow-5", "user-1", true);
    editor.connection.receive(updateMessage((doc) => doc.getMap("nodes").set("a", "doomed")));

    server.dropRoom("flow-5");
    await Bun.sleep(0);

    expect(editor.closed).toBe(true);
    expect(store.saves.length).toBe(0);
    expect(server.getRoomCount()).toBe(0);
  });
});
