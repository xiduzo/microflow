import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";

import { MemoryRoomStore } from "./room-store";
import { SyncProvider } from "./sync-provider";
import { YjsServer } from "./yjs-server";
import {
  MESSAGE_ACCESS,
  MESSAGE_ACK,
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
  MESSAGE_UNSAVED,
  MAX_REAUTH_ATTEMPTS,
  classifyClose,
} from "./protocol";

/**
 * What this class still owns after moving the transport onto `y-websocket`:
 * presence throttling, the local user record, the cached awareness view, and
 * our own `ack` message.
 *
 * Reconnect, backoff, the sync handshake, offline behaviour and dropping
 * remote presence on close are the library's — deliberately not retested here.
 * The tests that used to cover our hand-rolled versions were deleted with the
 * code, not ported.
 */

/** Minimal stand-in for the browser WebSocket that y-websocket drives. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  // Instance-level too: y-websocket guards its sends with
  // `ws.readyState === ws.OPEN`, reading the constant off the instance the way
  // the real WebSocket interface exposes it. Static-only and every send is
  // silently skipped.
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  binaryType = "arraybuffer";
  sent: Uint8Array[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(new Uint8Array(data));
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" });
  }

  /** Complete the handshake the way a real server would. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  framesOfType(type: number): Uint8Array[] {
    return this.sent.filter((frame) => {
      const decoder = decoding.createDecoder(frame);
      return decoding.readVarUint(decoder) === type;
    });
  }
}

const realWebSocket = globalThis.WebSocket;
let flowCounter = 0;

/** A provider on a flow of its own, with the socket it opened. */
function makeProvider(options: Partial<{ cursorThrottleMs: number }> = {}) {
  const doc = new Y.Doc();
  const provider = new SyncProvider({
    flowId: `flow-${++flowCounter}`,
    doc,
    wsUrl: "wss://example.test",
    user: { id: "user-1", name: "Ada" },
    WebSocketPolyfill: FakeSocket as unknown as typeof WebSocket,
    ...options,
  });
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1]!;
  return { doc, provider, socket };
}

beforeEach(() => {
  FakeSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
});

describe("SyncProvider presence throttling", () => {
  test("a burst of pointer moves collapses to one frame plus a trailing one", async () => {
    const { provider, socket } = makeProvider({ cursorThrottleMs: 40 });
    socket.open();
    socket.sent.length = 0;

    // ~100 moves is roughly one second of real pointer input.
    for (let i = 0; i < 100; i++) provider.updateCursor({ x: i, y: i });

    // Leading edge only so far; the rest coalesce into the pending slot.
    expect(socket.framesOfType(MESSAGE_AWARENESS).length).toBe(1);

    await new Promise((r) => setTimeout(r, 70));

    const frames = socket.framesOfType(MESSAGE_AWARENESS).length;
    expect(frames).toBe(2);
    // Unthrottled this burst cost 100 frames, each fanned out to every peer.
    expect(frames).toBeLessThan(100);

    provider.destroy();
  });

  test("the final position of a gesture is always sent", async () => {
    const { provider, socket } = makeProvider({ cursorThrottleMs: 30 });
    socket.open();

    for (let i = 0; i < 20; i++) provider.updateCursor({ x: i, y: i * 2 });
    await new Promise((r) => setTimeout(r, 60));

    expect(provider.localUser.cursor).toEqual({ x: 19, y: 38 });
    provider.destroy();
  });

  test("a cursor that has not moved is not re-broadcast", async () => {
    const { provider, socket } = makeProvider({ cursorThrottleMs: 20 });
    socket.open();

    provider.updateCursor({ x: 10, y: 10 });
    await new Promise((r) => setTimeout(r, 50));
    socket.sent.length = 0;

    // Sub-unit jitter rounds to the same flow coordinate and is dropped.
    for (let i = 0; i < 20; i++) provider.updateCursor({ x: 10.2, y: 9.8 });
    await new Promise((r) => setTimeout(r, 50));

    expect(socket.framesOfType(MESSAGE_AWARENESS).length).toBe(0);
    provider.destroy();
  });

  test("drag positions share the cursor's throttle and land on the final frame", async () => {
    const { provider, socket } = makeProvider({ cursorThrottleMs: 30 });
    socket.open();
    socket.sent.length = 0;

    for (let i = 0; i < 40; i++) provider.updateDraggedNodes({ n1: { x: i, y: i } });
    await new Promise((r) => setTimeout(r, 60));

    expect(socket.framesOfType(MESSAGE_AWARENESS).length).toBeLessThanOrEqual(3);
    expect(provider.localUser.draggingNodes).toEqual({ n1: { x: 39, y: 39 } });

    provider.updateDraggedNodes(null);
    await new Promise((r) => setTimeout(r, 60));
    expect(provider.localUser.draggingNodes).toBeUndefined();

    provider.destroy();
  });

  test("moving our own cursor does not notify awareness listeners", async () => {
    const { provider, socket } = makeProvider({ cursorThrottleMs: 10 });
    socket.open();

    let notifications = 0;
    provider.on("awareness", () => notifications++);

    for (let i = 0; i < 30; i++) provider.updateCursor({ x: i, y: i });
    await new Promise((r) => setTimeout(r, 60));

    // The local cursor is never rendered, so waking React for it is pure cost.
    expect(notifications).toBe(0);
    provider.destroy();
  });

  test("selection is not re-sent when it has not changed", () => {
    const { provider, socket } = makeProvider();
    socket.open();
    socket.sent.length = 0;

    provider.updateSelectedNodes(["a", "b"]);
    provider.updateSelectedNodes(["a", "b"]);
    provider.updateSelectedNodes(["a", "b"]);
    expect(socket.framesOfType(MESSAGE_AWARENESS).length).toBe(1);

    provider.updateSelectedNodes(["a"]);
    expect(socket.framesOfType(MESSAGE_AWARENESS).length).toBe(2);

    provider.destroy();
  });
});

describe("SyncProvider ack message", () => {
  test("an ack frame from the server is decoded and emitted", () => {
    const { provider, socket } = makeProvider();
    socket.open();

    let acked: number | undefined;
    provider.on("ack", (version) => {
      acked = version;
    });

    // MESSAGE_ACK must not collide with y-websocket's reserved 0-3, or the
    // provider hands this frame to readAuthMessage instead of our handler.
    const frame = new Uint8Array([MESSAGE_ACK, 42]);
    socket.onmessage?.({ data: frame.buffer as ArrayBuffer });

    expect(acked).toBe(42);
    provider.destroy();
  });

  test("the ack type sits outside the range y-websocket reserves", () => {
    expect(MESSAGE_ACK).toBeGreaterThan(3);
  });
});

describe("SyncProvider lifecycle", () => {
  test("state tracks the transport through connect and sync", () => {
    const { provider, socket } = makeProvider();
    const states: string[] = [];
    provider.on("state", (s) => states.push(s));

    socket.open();
    expect(provider.state).toBe("syncing");
    expect(provider.isConnected()).toBe(true);

    socket.close();
    expect(provider.state).toBe("disconnected");
    expect(states).toContain("syncing");
    expect(states).toContain("disconnected");

    provider.destroy();
  });

  test("the local user is announced with a stable identity", () => {
    const { provider, socket } = makeProvider();
    socket.open();

    const local = provider.users.find((u) => u.clientId === provider.localUser.clientId);
    expect(local?.id).toBe("user-1");
    expect(local?.name).toBe("Ada");
    expect(local?.color).toMatch(/^#[0-9a-f]{6}$/i);

    provider.destroy();
  });

  test("users keeps its identity between changes", () => {
    const { provider, socket } = makeProvider();
    socket.open();

    const first = provider.users;
    expect(provider.users).toBe(first);

    provider.updateSelectedNodes(["a"]);
    expect(provider.users).not.toBe(first);

    provider.destroy();
  });

  test("destroy is idempotent and stops further presence work", async () => {
    const { provider, socket } = makeProvider({ cursorThrottleMs: 10 });
    socket.open();

    provider.destroy();
    provider.destroy();

    socket.sent.length = 0;
    provider.updateCursor({ x: 5, y: 5 });
    await new Promise((r) => setTimeout(r, 30));
    expect(socket.sent.length).toBe(0);
  });
});

/** The server ending the connection with a close code, as a real socket would. */
function serverClose(socket: FakeSocket, code: number, reason = ""): void {
  socket.readyState = FakeSocket.CLOSED;
  socket.onclose?.({ code, reason });
}

/** y-websocket's first retry fires after 2^1 * 100ms. */
const FIRST_RETRY_MS = 260;

describe("SyncProvider auth and access", () => {
  function makeAuthedProvider(
    readToken: () => string | undefined,
    extra: { refreshAuth?: () => Promise<unknown>; reauthBaseMs?: number } = {},
  ) {
    const doc = new Y.Doc();
    const provider = new SyncProvider({
      flowId: `flow-${++flowCounter}`,
      doc,
      wsUrl: "wss://example.test",
      user: { id: "user-1", name: "Ada" },
      authToken: readToken,
      reauthBaseMs: 20,
      ...extra,
      WebSocketPolyfill: FakeSocket as unknown as typeof WebSocket,
    });
    return { doc, provider };
  }

  const lastSocket = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;
  const tokenOf = (socket: FakeSocket) => new URL(socket.url).searchParams.get("token");

  test("a reconnect after token expiry presents the refreshed token", async () => {
    let token = "token-a";
    const { provider } = makeAuthedProvider(() => token);
    const first = lastSocket();
    expect(tokenOf(first)).toBe("token-a");
    first.open();

    // The session was refreshed while connected; then the network blipped.
    token = "token-b";
    serverClose(first, 1006);
    await new Promise((r) => setTimeout(r, FIRST_RETRY_MS));

    const second = lastSocket();
    expect(second).not.toBe(first);
    expect(tokenOf(second)).toBe("token-b");
    provider.destroy();
  });

  test("a token rotated after the close, before the retry, is the one presented", async () => {
    let token = "token-a";
    const { provider } = makeAuthedProvider(() => token);
    const first = lastSocket();
    first.open();

    serverClose(first, 1006);
    // The auth client rotates the token during y-websocket's backoff.
    await new Promise((r) => setTimeout(r, 50));
    token = "token-b";
    await new Promise((r) => setTimeout(r, FIRST_RETRY_MS));

    expect(tokenOf(lastSocket())).toBe("token-b");
    provider.destroy();
  });

  test("the refresh timeout is cleared when the refresh settles, on reconnect, and on destroy", async () => {
    const pending: Array<() => void> = [];
    const refreshAuth = () => new Promise<void>((resolve) => pending.push(resolve));
    const closeUnauthorized = () => {
      const socket = lastSocket();
      socket.open();
      serverClose(socket, 1008, "Unauthorized");
    };

    // Settles: the 10s cap is disarmed with it.
    const settled = makeAuthedProvider(() => "t", { refreshAuth });
    closeUnauthorized();
    expect(settled.provider.hasPendingRefreshTimeout).toBe(true);
    pending.shift()!();
    await new Promise((r) => setTimeout(r, 5));
    expect(settled.provider.hasPendingRefreshTimeout).toBe(false);
    settled.provider.destroy();

    // Cancelled by an explicit reconnect.
    const reconnected = makeAuthedProvider(() => "t", { refreshAuth });
    closeUnauthorized();
    expect(reconnected.provider.hasPendingRefreshTimeout).toBe(true);
    reconnected.provider.reconnect();
    expect(reconnected.provider.hasPendingRefreshTimeout).toBe(false);
    reconnected.provider.destroy();

    // Cancelled by destroy.
    const destroyed = makeAuthedProvider(() => "t", { refreshAuth });
    closeUnauthorized();
    expect(destroyed.provider.hasPendingRefreshTimeout).toBe(true);
    destroyed.provider.destroy();
    expect(destroyed.provider.hasPendingRefreshTimeout).toBe(false);
  });

  test("re-auth waits for a slow token refresh instead of spending its budget", async () => {
    let token = "expired";
    let finishRefresh!: () => void;
    const refreshAuth = () =>
      new Promise<void>((resolve) => {
        finishRefresh = () => {
          token = "fresh";
          resolve();
        };
      });
    const { provider } = makeAuthedProvider(() => token, { refreshAuth, reauthBaseMs: 10 });
    const denied: string[] = [];
    provider.on("accessDenied", (reason) => denied.push(reason));

    const first = lastSocket();
    first.open();
    serverClose(first, 1008, "Unauthorized");

    // Well past the backoff: still waiting on the refresh, nothing spent.
    await new Promise((r) => setTimeout(r, 300));
    expect(FakeSocket.instances.length).toBe(1);
    expect(denied).toEqual([]);

    finishRefresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeSocket.instances.length).toBe(2);
    expect(tokenOf(lastSocket())).toBe("fresh");
    provider.destroy();
  });

  test("4403 Forbidden is terminal: no retry, and the reason is surfaced", async () => {
    const { provider } = makeAuthedProvider(() => "token");
    const denied: Array<[string, number]> = [];
    provider.on("accessDenied", (reason, code) => denied.push([reason, code]));

    const first = lastSocket();
    first.open();
    serverClose(first, 4403, "Forbidden");
    await new Promise((r) => setTimeout(r, FIRST_RETRY_MS));

    expect(denied).toEqual([["Forbidden", 4403]]);
    expect(FakeSocket.instances.length).toBe(1);
    expect(provider.state).toBe("disconnected");
    provider.destroy();
  });

  test("1008 Unauthorized retries with a re-read token, then gives up", async () => {
    let reads = 0;
    const { provider } = makeAuthedProvider(() => `token-${++reads}`);
    const denied: Array<[string, number]> = [];
    provider.on("accessDenied", (reason, code) => denied.push([reason, code]));

    // Every attempt is refused; re-auth backs off 20, 40, 80ms here.
    for (let attempt = 0; attempt <= MAX_REAUTH_ATTEMPTS; attempt++) {
      const socket = lastSocket();
      socket.open();
      serverClose(socket, 1008, "Unauthorized");
      if (attempt < MAX_REAUTH_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 30 * 2 ** attempt));
        expect(lastSocket()).not.toBe(socket);
      }
    }
    await new Promise((r) => setTimeout(r, 200));

    const tokens = FakeSocket.instances.map(tokenOf);
    expect(new Set(tokens).size).toBe(tokens.length); // a fresh read per attempt
    expect(FakeSocket.instances.length).toBe(MAX_REAUTH_ATTEMPTS + 1);
    expect(denied).toEqual([["Unauthorized", 1008]]);

    // An explicit reconnect (the user signed in again) refills the budget.
    provider.reconnect();
    const resumed = lastSocket();
    resumed.open();
    serverClose(resumed, 1008, "Unauthorized");
    await new Promise((r) => setTimeout(r, 60));
    expect(lastSocket()).not.toBe(resumed);
    provider.destroy();
  });

  test("an explicit reconnect after a terminal close tries again with a fresh token", () => {
    let token = "expired";
    const { provider } = makeAuthedProvider(() => token);
    const first = lastSocket();
    first.open();
    serverClose(first, 4401, "Access revoked");

    token = "renewed";
    provider.reconnect();
    expect(FakeSocket.instances.length).toBe(2);
    expect(tokenOf(lastSocket())).toBe("renewed");
    provider.destroy();
  });

  test("a server access frame is decoded and emitted", () => {
    const { provider } = makeAuthedProvider(() => undefined);
    const socket = lastSocket();
    socket.open();
    const seen: string[] = [];
    provider.on("access", (access) => seen.push(access));

    // MESSAGE_ACCESS, then the ACCESS_CODES index ("read" = 1).
    socket.onmessage?.({ data: new Uint8Array([MESSAGE_ACCESS, 1]).buffer as ArrayBuffer });

    expect(seen).toEqual(["read"]);
    expect(provider.access).toBe("read");
    expect(MESSAGE_ACCESS).toBeGreaterThan(3);
    provider.destroy();
  });

  test("an unsaved frame is decoded with its reason", () => {
    const { provider } = makeAuthedProvider(() => undefined);
    const socket = lastSocket();
    socket.open();
    const seen: string[] = [];
    provider.on("unsaved", (reason) => seen.push(reason));
    socket.onmessage?.({ data: new Uint8Array([MESSAGE_UNSAVED, 0]).buffer as ArrayBuffer });
    socket.onmessage?.({ data: new Uint8Array([MESSAGE_UNSAVED, 1]).buffer as ArrayBuffer });
    expect(seen).toEqual(["pending", "failed"]);
    provider.destroy();
  });

  test("a promotion from read to write starts a fresh handshake", async () => {
    const { provider } = makeAuthedProvider(() => undefined);
    const socket = lastSocket();
    socket.open();
    socket.onmessage?.({ data: new Uint8Array([MESSAGE_ACCESS, 1]).buffer as ArrayBuffer });
    expect(FakeSocket.instances.length).toBe(1);

    socket.onmessage?.({ data: new Uint8Array([MESSAGE_ACCESS, 2]).buffer as ArrayBuffer });
    await Promise.resolve();
    expect(FakeSocket.instances.length).toBe(2);
    provider.destroy();
  });

  test("local edits are reported; edits arriving from the server are not", () => {
    const { doc, provider } = makeAuthedProvider(() => undefined);
    const socket = lastSocket();
    socket.open();
    let local = 0;
    provider.on("localUpdate", () => local++);

    doc.getMap("nodes").set("a", 1);
    expect(local).toBe(1);

    // A remote update: sync message type 2 (update) wrapping a peer's change.
    const peer = new Y.Doc();
    peer.getMap("nodes").set("b", 2);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(peer));
    socket.onmessage?.({ data: encoding.toUint8Array(encoder).buffer as ArrayBuffer });

    expect(doc.getMap("nodes").get("b")).toBe(2);
    expect(local).toBe(1);
    provider.destroy();
  });

  test("close classification follows the server's codes", () => {
    // 1008 is "Unauthorized", or an older server's ambiguous "Forbidden"
    // (denial or DB error): bounded retries either way.
    expect(classifyClose(1008)).toBe("reauth");
    expect(classifyClose(4401)).toBe("terminal"); // revoked
    expect(classifyClose(4403)).toBe("terminal"); // denied
    expect(classifyClose(4404)).toBe("terminal"); // flow deleted
    for (const code of [1000, 1005, 1006, 1011, 1012, 1013, 4500]) {
      expect(classifyClose(code)).toBe("retry");
    }
  });

  test("a retryable close is reported as a drop with its code", () => {
    const { provider } = makeAuthedProvider(() => undefined);
    const drops: number[] = [];
    provider.on("dropped", (code) => drops.push(code));
    const socket = lastSocket();
    socket.open();
    serverClose(socket, 1012, "Server restarting");
    expect(drops).toEqual([1012]);
    provider.destroy();
  });
});

describe("SyncProvider: tabs of one browser sync through the server only", () => {
  /** One user with the same flow open in two tabs of one browser. */
  function twoTabs() {
    const flowId = `flow-${++flowCounter}`;
    const tab = () => {
      const doc = new Y.Doc();
      const provider = new SyncProvider({
        flowId,
        doc,
        wsUrl: "wss://example.test",
        user: { id: "user-1", name: "Ada" },
        WebSocketPolyfill: FakeSocket as unknown as typeof WebSocket,
      });
      return { doc, provider, socket: FakeSocket.instances[FakeSocket.instances.length - 1]! };
    };
    return { flowId, a: tab(), b: tab() };
  }

  const others = (tab: { doc: Y.Doc; provider: SyncProvider }) =>
    tab.provider.users.filter((user) => user.clientId !== tab.doc.clientID);

  test("with no server relaying, an edit and a selection in one tab do not reach the other", () => {
    const { a, b } = twoTabs();
    a.socket.open();
    b.socket.open();
    a.socket.sent.length = 0;

    a.doc.getMap("nodes").set("n1", "led");
    a.provider.updateSelectedNodes(["n1"]);

    // The sockets go nowhere, so the server is the one path that is missing.
    expect(b.doc.getMap("nodes").size).toBe(0);
    expect(others(b)).toEqual([]);
    // Both were handed to the server.
    expect(a.socket.framesOfType(MESSAGE_SYNC).length).toBe(1);
    expect(a.socket.framesOfType(MESSAGE_AWARENESS).length).toBe(1);

    a.provider.destroy();
    b.provider.destroy();
  });

  /** Attach a tab's socket to a room of `server`, as the transport does. */
  async function attach(server: YjsServer, flowId: string, socket: FakeSocket) {
    // Frames the room sends while the tab is still joining wait for it.
    const waiting: Uint8Array[] = [];
    let deliver: (frame: Uint8Array) => void = (frame) => waiting.push(frame);
    const connection = await server.join(
      flowId,
      { send: (frame) => deliver(frame), close() {} },
      "user-1",
      true,
    );
    socket.send = (frame) => connection.receive(new Uint8Array(frame));
    socket.open();
    deliver = (frame) => socket.onmessage?.({ data: frame.slice().buffer as ArrayBuffer });
    waiting.forEach(deliver);
    return connection;
  }

  test("through the server, each tab sees the other's edits and presence", async () => {
    const server = new YjsServer({ store: new MemoryRoomStore(), persistDebounce: 60_000 });
    const { flowId, a, b } = twoTabs();
    const connections = [
      await attach(server, flowId, a.socket),
      await attach(server, flowId, b.socket),
    ];

    a.doc.getMap("nodes").set("n1", "led");
    b.doc.getMap("nodes").set("n2", "button");
    a.provider.updateSelectedNodes(["n1"]);

    expect(b.doc.getMap("nodes").toJSON()).toEqual({ n1: "led", n2: "button" });
    expect(a.doc.getMap("nodes").toJSON()).toEqual({ n1: "led", n2: "button" });
    // Two tabs of one user are two people in the room, to each other as well.
    expect(others(b).map((user) => [user.clientId, user.id, user.selectedNodes])).toEqual([
      [a.doc.clientID, "user-1", ["n1"]],
    ]);
    expect(others(a).map((user) => user.clientId)).toEqual([b.doc.clientID]);

    a.provider.destroy();
    b.provider.destroy();
    connections.forEach((connection) => connection.close());
  });
});
