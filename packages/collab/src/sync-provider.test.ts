import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";

import { SyncProvider } from "./sync-provider";
import { MESSAGE_ACK, MESSAGE_AWARENESS } from "./protocol";

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

/** Distinct flow ids per provider: y-websocket relays between providers in the
 *  same process over its cross-tab BroadcastChannel, keyed by url + room. */
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
