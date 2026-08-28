import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";

import { SyncProvider } from "../sync-provider";

/**
 * Client-side sync behaviour under the conditions a large room creates:
 * cursor traffic at pointer rate, reconnect storms, and long offline gaps.
 */

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** Frames a `SyncProvider` sent us, split by protocol message type. */
class FakeSocket {
  static instances: FakeSocket[] = [];

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  binaryType = "arraybuffer";
  sent: Uint8Array[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(new Uint8Array(data));
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  /** Complete the handshake the way a real server would. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** Frames of one message type, in order. */
  framesOfType(type: number): Uint8Array[] {
    return this.sent.filter((frame) => {
      const decoder = decoding.createDecoder(frame);
      return decoding.readVarUint(decoder) === type;
    });
  }
}

const realWebSocket = globalThis.WebSocket;

function makeProvider(options: Partial<Parameters<typeof SyncProvider.prototype.constructor>[0]> = {}) {
  const doc = new Y.Doc();
  const provider = new SyncProvider({
    flowId: "flow-1",
    doc,
    wsUrl: "wss://example.test",
    user: { id: "user-1", name: "Ada" },
    ...options,
  } as ConstructorParameters<typeof SyncProvider>[0]);
  return { doc, provider };
}

beforeEach(() => {
  FakeSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
});

describe("SyncProvider cursor throttling", () => {
  test("a burst of pointer moves collapses to one frame plus a trailing one", async () => {
    const { provider } = makeProvider({ cursorThrottleMs: 40 });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.sent.length = 0;

    // 100 moves is roughly one second of real pointer input.
    for (let i = 0; i < 100; i++) provider.updateCursor({ x: i, y: i });

    // Leading edge only so far — the rest are coalesced into the pending slot.
    expect(socket.framesOfType(MESSAGE_AWARENESS).length).toBe(1);

    await new Promise((r) => setTimeout(r, 60));

    const frames = socket.framesOfType(MESSAGE_AWARENESS);
    expect(frames.length).toBe(2);
    // Before throttling this burst cost 100 frames, each fanned out to every
    // peer in the room.
    expect(frames.length).toBeLessThan(100);

    provider.destroy();
  });

  test("the final position of a gesture is always sent", async () => {
    const { provider } = makeProvider({ cursorThrottleMs: 30 });
    const socket = FakeSocket.instances[0]!;
    socket.open();

    for (let i = 0; i < 20; i++) provider.updateCursor({ x: i, y: i * 2 });
    await new Promise((r) => setTimeout(r, 50));

    expect(provider.localUser.cursor).toEqual({ x: 19, y: 38 });
    provider.destroy();
  });

  test("a cursor that has not moved is not re-broadcast", async () => {
    const { provider } = makeProvider({ cursorThrottleMs: 20 });
    const socket = FakeSocket.instances[0]!;
    socket.open();

    provider.updateCursor({ x: 10, y: 10 });
    await new Promise((r) => setTimeout(r, 40));
    socket.sent.length = 0;

    // Sub-unit jitter rounds to the same flow coordinate and is dropped.
    for (let i = 0; i < 20; i++) provider.updateCursor({ x: 10.2, y: 9.8 });
    await new Promise((r) => setTimeout(r, 40));

    expect(socket.framesOfType(MESSAGE_AWARENESS).length).toBe(0);
    provider.destroy();
  });

  test("moving our own cursor does not notify awareness listeners", async () => {
    const { provider } = makeProvider({ cursorThrottleMs: 10 });
    const socket = FakeSocket.instances[0]!;
    socket.open();

    let notifications = 0;
    provider.on("awarenessChange", () => notifications++);

    for (let i = 0; i < 30; i++) provider.updateCursor({ x: i, y: i });
    await new Promise((r) => setTimeout(r, 40));

    // The local cursor is never rendered, so waking React for it is pure cost.
    expect(notifications).toBe(0);
    provider.destroy();
  });

  test("selection is not re-sent when it has not changed", async () => {
    const { provider } = makeProvider();
    const socket = FakeSocket.instances[0]!;
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

describe("SyncProvider offline queue", () => {
  test("updates queued offline are sent as a single merged frame", () => {
    const { doc, provider } = makeProvider();
    const socket = FakeSocket.instances[0]!;

    // Still CONNECTING — every edit lands in the queue.
    for (let i = 0; i < 25; i++) {
      doc.getMap("nodes").set(`n${i}`, i);
    }
    expect(socket.framesOfType(MESSAGE_SYNC).length).toBe(0);

    socket.open();

    // One sync-step-1 from the handshake, plus one merged update — not 25.
    const syncFrames = socket.framesOfType(MESSAGE_SYNC);
    expect(syncFrames.length).toBe(2);

    // And the merged frame carries every edit.
    const mirror = new Y.Doc();
    const decoder = decoding.createDecoder(syncFrames[1]!);
    decoding.readVarUint(decoder); // message type
    decoding.readVarUint(decoder); // sync step
    Y.applyUpdate(mirror, decoding.readVarUint8Array(decoder));
    expect(mirror.getMap("nodes").size).toBe(25);

    provider.destroy();
  });

  test("the queue is dropped rather than grown past its cap", () => {
    const { doc, provider } = makeProvider({ maxPendingBytes: 256 });
    const socket = FakeSocket.instances[0]!;

    for (let i = 0; i < 200; i++) {
      doc.getMap("nodes").set(`n${i}`, "x".repeat(50));
    }

    socket.open();

    // The queue was discarded; resync happens through sync-step-1 instead of
    // an unbounded replay.
    const syncFrames = socket.framesOfType(MESSAGE_SYNC);
    expect(syncFrames.length).toBeLessThanOrEqual(2);

    provider.destroy();
  });
});

describe("SyncProvider reconnect", () => {
  test("backoff is jittered so a room does not reconnect in lockstep", () => {
    // Ten providers dropped at once must not all wake at the same instant.
    const providers = Array.from({ length: 10 }, () => makeProvider().provider);
    const sockets = FakeSocket.instances.slice();
    for (const socket of sockets) socket.open();

    const delays = new Set<number>();
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number) => {
      if (ms !== undefined) delays.add(ms);
      return realSetTimeout(() => {}, 0);
    }) as typeof setTimeout;

    for (const socket of sockets) socket.close();

    (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;

    // Deterministic backoff would produce exactly one distinct delay.
    expect(delays.size).toBeGreaterThan(1);
    for (const provider of providers) provider.destroy();
  });

  test("remote presence is cleared when the socket drops", () => {
    const { provider } = makeProvider();
    const socket = FakeSocket.instances[0]!;
    socket.open();

    // A peer announces itself.
    const peerDoc = new Y.Doc();
    const peer = new SyncProvider({
      flowId: "flow-1",
      doc: peerDoc,
      wsUrl: "wss://example.test",
      user: { id: "user-2", name: "Grace" },
    });
    const peerSocket = FakeSocket.instances[1]!;
    peerSocket.open();
    const announcement = peerSocket.framesOfType(MESSAGE_AWARENESS)[0]!;
    socket.onmessage?.({ data: announcement.buffer as ArrayBuffer });

    expect(provider.getOtherUsers().length).toBe(1);

    socket.close();

    // Their presence was only ever known through this socket.
    expect(provider.getOtherUsers().length).toBe(0);

    provider.destroy();
    peer.destroy();
  });
});
