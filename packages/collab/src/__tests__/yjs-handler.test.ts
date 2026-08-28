import { describe, expect, mock, test } from "bun:test";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

/**
 * The handler is the composition root: it wires the singleton `YjsServer` to
 * the production `RoomStore`, so importing it reaches the database. Stub it —
 * everything below is about the transport, not persistence.
 */
const saved: unknown[] = [];
mock.module("@microflow/db", () => ({
  db: {
    query: { flow: { findFirst: async () => ({ id: "flow-1", ydoc: null }) } },
    update: () => ({ set: () => ({ where: async (w: unknown) => saved.push(w) }) }),
  },
}));

const { createYjsHandler, yjsServer } = await import("../handler");
const { CLOSE_ACCESS_DENIED } = await import("../protocol");

const MESSAGE_SYNC = 0;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function updateMessage(mutate: (doc: Y.Doc) => void): ArrayBuffer {
  const client = new Y.Doc();
  mutate(client);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client));
  return toArrayBuffer(encoding.toUint8Array(encoder));
}

function syncStep1Message(): ArrayBuffer {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, new Y.Doc());
  return toArrayBuffer(encoding.toUint8Array(encoder));
}

/** A stand-in for Hono's `WSContext` — records what the server sent. */
function fakeSocket(flowId: string, userId: string, canWrite: boolean) {
  const sent: Uint8Array[] = [];
  const raw = { flowId, userId, canWrite };
  const ws = {
    raw,
    send: (data: ArrayBuffer) => sent.push(new Uint8Array(data)),
    close: () => {},
  };
  return {
    ws: ws as never,
    sent,
    /** Replay everything the server sent into a mirror doc. */
    mirror() {
      const doc = new Y.Doc();
      for (const message of sent) {
        const decoder = decoding.createDecoder(message);
        if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
        syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), doc, null);
      }
      return doc;
    },
  };
}

/**
 * These drive the handler the way Hono does — onOpen, then onMessage with a
 * fresh event each time. The room must recognise the sender across those
 * separate callbacks; a connection identified by anything the transport
 * re-creates per message (an object literal, say) fails here while passing
 * every test written against `YjsServer` directly.
 */
describe("createYjsHandler transport", () => {
  test("an editor's update sent through the handler reaches the room", async () => {
    const handler = createYjsHandler();
    const editor = fakeSocket("flow-h1", "editor-1", true);

    await handler.onOpen(new Event("open"), editor.ws);
    handler.onMessage(
      { data: updateMessage((d) => d.getMap("nodes").set("a", "editor-wrote-this")) } as MessageEvent,
      editor.ws,
    );

    // Read it back the way a client would: ask for the room's state.
    handler.onMessage({ data: syncStep1Message() } as MessageEvent, editor.ws);
    expect(editor.mirror().getMap("nodes").get("a")).toBe("editor-wrote-this");

    handler.onClose(new CloseEvent("close"), editor.ws);
  });

  test("a viewer's update sent through the handler is dropped", async () => {
    const handler = createYjsHandler();
    const editor = fakeSocket("flow-h2", "editor-1", true);
    const viewer = fakeSocket("flow-h2", "viewer-1", false);

    await handler.onOpen(new Event("open"), editor.ws);
    await handler.onOpen(new Event("open"), viewer.ws);

    handler.onMessage(
      { data: updateMessage((d) => d.getMap("nodes").set("a", "owned")) } as MessageEvent,
      editor.ws,
    );
    handler.onMessage(
      { data: updateMessage((d) => d.getMap("nodes").set("b", "viewer-wrote-this")) } as MessageEvent,
      viewer.ws,
    );

    handler.onMessage({ data: syncStep1Message() } as MessageEvent, viewer.ws);
    const mirror = viewer.mirror();
    expect(mirror.getMap("nodes").has("b")).toBe(false);
    expect(mirror.getMap("nodes").get("a")).toBe("owned");

    handler.onClose(new CloseEvent("close"), editor.ws);
    handler.onClose(new CloseEvent("close"), viewer.ws);
  });

  test("messages arriving before onOpen resolves are replayed once the handle exists", async () => {
    const handler = createYjsHandler();
    const early = fakeSocket("flow-h3", "editor-1", true);

    // No await: the handle does not exist yet. A real client sends
    // sync-step-1 the instant the socket opens, so this window is always hit;
    // dropping the frame left the client stuck in `syncing`.
    const opening = handler.onOpen(new Event("open"), early.ws);
    handler.onMessage(
      { data: updateMessage((d) => d.getMap("nodes").set("a", "sent-early")) } as MessageEvent,
      early.ws,
    );
    await opening;

    handler.onMessage({ data: syncStep1Message() } as MessageEvent, early.ws);
    expect(early.mirror().getMap("nodes").get("a")).toBe("sent-early");

    handler.onClose(new CloseEvent("close"), early.ws);
  });

  test("an early message is still subject to the connection's access decision", async () => {
    const handler = createYjsHandler();
    const viewer = fakeSocket("flow-h3b", "viewer-1", false);

    // Replaying buffered frames must go through the room handle, not around
    // it — a Viewer's write is dropped whether it arrived early or late.
    const opening = handler.onOpen(new Event("open"), viewer.ws);
    handler.onMessage(
      { data: updateMessage((d) => d.getMap("nodes").set("a", "viewer-wrote-this")) } as MessageEvent,
      viewer.ws,
    );
    await opening;

    handler.onMessage({ data: syncStep1Message() } as MessageEvent, viewer.ws);
    expect(viewer.mirror().getMap("nodes").has("a")).toBe(false);

    handler.onClose(new CloseEvent("close"), viewer.ws);
  });

  test("a socket that closes mid-join does not leave a handle behind", async () => {
    const handler = createYjsHandler();
    const abandoned = fakeSocket("flow-h3c", "editor-1", true);

    const opening = handler.onOpen(new Event("open"), abandoned.ws);
    handler.onClose(new CloseEvent("close"), abandoned.ws);
    await opening;

    expect(yjsServer.getConnectionCount("flow-h3c")).toBe(0);
  });

  test("onClose detaches the connection from the room", async () => {
    const handler = createYjsHandler();
    const peer = fakeSocket("flow-h4", "editor-1", true);

    await handler.onOpen(new Event("open"), peer.ws);
    expect(yjsServer.getConnectionCount("flow-h4")).toBe(1);

    handler.onClose(new CloseEvent("close"), peer.ws);
    expect(yjsServer.getConnectionCount("flow-h4")).toBe(0);
  });

  test("a socket the endpoint never authorized is closed", async () => {
    const handler = createYjsHandler();
    let closedWith: number | undefined;
    const ws = {
      raw: { flowId: "flow-h5", userId: "someone" }, // no access decision
      send: () => {},
      close: (code: number) => (closedWith = code),
    };

    await handler.onOpen(new Event("open"), ws as never);

    // 4400-4499 tells WebsocketProvider not to reconnect: the endpoint only
    // sets these after authorizing, so retrying cannot succeed.
    expect(closedWith).toBe(CLOSE_ACCESS_DENIED);
    expect(yjsServer.getConnectionCount("flow-h5")).toBe(0);
  });
});
