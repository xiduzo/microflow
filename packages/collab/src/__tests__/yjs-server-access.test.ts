import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// The room loads/persists through the db; stub it so this test needs no
// DATABASE_URL. `ydoc: null` => the server starts from an empty document.
const updates: unknown[] = [];
mock.module("@microflow/db", () => ({
  db: {
    query: { flow: { findFirst: async () => ({ id: "flow-1", ydoc: null }) } },
    update: () => ({ set: () => ({ where: async (w: unknown) => updates.push(w) }) }),
  },
}));

const { YjsServer } = await import("../yjs-server");

const MESSAGE_SYNC = 0;

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

function connect(server: InstanceType<typeof YjsServer>, canWrite: boolean) {
  const received: Uint8Array[] = [];
  const connection = { send: (d: Uint8Array) => received.push(d), close: () => {} };
  return {
    connection,
    received,
    open: () => server.handleConnection("flow-1", connection, "user-1", canWrite),
  };
}

describe("YjsServer write authorization", () => {
  let server: InstanceType<typeof YjsServer>;

  beforeEach(() => {
    server = new YjsServer({ persistDebounce: 60_000 });
  });

  test("an editor connection's update is applied to the room", async () => {
    const editor = connect(server, true);
    await editor.open();

    server.handleMessage(
      "flow-1",
      editor.connection,
      updateMessage((doc) => doc.getMap("nodes").set("a", "editor-wrote-this"),
      ),
    );

    // Reading back through a second connection's sync step 1 proves the room
    // doc actually changed.
    const observer = connect(server, false);
    await observer.open();
    const mirror = new Y.Doc();
    for (const message of observer.received) {
      const decoder = decoding.createDecoder(message);
      if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), mirror, null);
    }
    server.handleMessage("flow-1", observer.connection, syncStep1Message(mirror));
    for (const message of observer.received) {
      const decoder = decoding.createDecoder(message);
      if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), mirror, null);
    }

    expect(mirror.getMap("nodes").get("a")).toBe("editor-wrote-this");
  });

  test("a read-only connection's update is dropped, and it can still read", async () => {
    const editor = connect(server, true);
    await editor.open();
    server.handleMessage(
      "flow-1",
      editor.connection,
      updateMessage((doc) => doc.getMap("nodes").set("a", "owned")),
    );

    const viewer = connect(server, false);
    await viewer.open();
    // A distinct key, so this asserts the write was dropped rather than
    // relying on Y.Map's clientID-ordered conflict resolution.
    server.handleMessage(
      "flow-1",
      viewer.connection,
      updateMessage((doc) => doc.getMap("nodes").set("b", "viewer-wrote-this")),
    );

    const mirror = new Y.Doc();
    server.handleMessage("flow-1", viewer.connection, syncStep1Message(mirror));
    for (const message of viewer.received) {
      const decoder = decoding.createDecoder(message);
      if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), mirror, null);
    }

    // The viewer's write never lands...
    expect(mirror.getMap("nodes").has("b")).toBe(false);
    // ...but the viewer still receives the document (read access intact).
    expect(mirror.getMap("nodes").get("a")).toBe("owned");
  });

  test("a connection the room does not know is treated as read-only", async () => {
    const editor = connect(server, true);
    await editor.open();
    server.handleMessage(
      "flow-1",
      editor.connection,
      updateMessage((doc) => doc.getMap("nodes").set("a", "owned")),
    );

    const stranger = { send: () => {}, close: () => {} };
    server.handleMessage(
      "flow-1",
      stranger,
      updateMessage((doc) => doc.getMap("nodes").set("b", "stranger-wrote-this")),
    );

    const mirror = new Y.Doc();
    server.handleMessage("flow-1", editor.connection, syncStep1Message(mirror));
    for (const message of editor.received) {
      const decoder = decoding.createDecoder(message);
      if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), mirror, null);
    }

    expect(mirror.getMap("nodes").has("b")).toBe(false);
    expect(mirror.getMap("nodes").get("a")).toBe("owned");
  });
});
