import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import {
  FlowDocument,
  MESSAGE_ACCESS,
  MESSAGE_ACK,
  MESSAGE_SYNC,
  SyncProvider,
  type SyncProviderEvents,
  type SyncState,
} from "@microflow/collab";
import {
  SessionStatusMachine,
  bindSessionStatus,
  initialSessionStatusState,
  localSessionStatus,
  type LocalPersistenceSource,
  type SessionStatusSource,
} from "./session-status";import { makeSession, withLiveAccess } from "./flow-session";
import type { SyncAdapter } from "./sync-adapter";

// ----------------------------------------------------------------------------
// Fake provider: the `SessionStatusSource` slice, scripted.
// ----------------------------------------------------------------------------

type Events = Pick<
  SyncProviderEvents,
  "state" | "ack" | "unsaved" | "access" | "accessDenied" | "localUpdate" | "dropped"
>;

class FakeSource implements SessionStatusSource {
  state: SyncState = "connecting";
  access: "read" | "write" | null = null;
  private readonly listeners = new Map<keyof Events, Set<Function>>();

  on<K extends keyof Events>(event: K, cb: Events[K]): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
    return () => this.listeners.get(event)?.delete(cb);
  }

  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    if (event === "state") this.state = args[0] as SyncState;
    this.listeners.get(event)?.forEach((cb) => cb(...args));
  }

  /** A full connect: socket up, then the sync handshake lands. */
  connect(): void {
    this.emit("state", "syncing");
    this.emit("state", "synced");
  }

  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

function setup(readOnly = false) {
  const source = new FakeSource();
  const machine = new SessionStatusMachine(initialSessionStatusState({ readOnly }));
  const unbind = bindSessionStatus(machine, source);
  return { source, machine, unbind, status: () => machine.getSnapshot() };
}

describe("Flow Session Status", () => {
  test("connecting → syncing → connected, then saving and saved around an ack", () => {
    const { source, status } = setup();
    expect(status().kind).toBe("connecting");

    source.emit("state", "syncing");
    expect(status().kind).toBe("syncing");
    source.emit("state", "synced");
    expect(status().kind).toBe("connected");

    source.emit("localUpdate");
    expect(status().kind).toBe("saving");
    expect(status().unsyncedChanges).toBe(0);

    source.emit("ack", 1234);
    expect(status().kind).toBe("saved");
    expect(status().lastSavedAt).toBe(1234);
  });

  test("offline edits are counted, then delivered on resync and cleared by the ack", () => {
    const { source, status } = setup();
    source.connect();

    source.emit("state", "disconnected");
    expect(status().kind).toBe("offline");

    source.emit("localUpdate");
    source.emit("localUpdate");
    source.emit("state", "connecting"); // y-websocket retrying
    source.emit("localUpdate");
    expect(status().kind).toBe("offline");
    expect(status().unsyncedChanges).toBe(3);

    source.connect();
    expect(status().unsyncedChanges).toBe(0);
    expect(status().kind).toBe("saving");

    source.emit("ack", 99);
    expect(status().kind).toBe("saved");
  });

  test("a first connection that is refused reads as offline, not connecting forever", () => {
    const { source, status } = setup();
    source.emit("state", "disconnected");
    source.emit("state", "connecting");
    expect(status().kind).toBe("offline");
  });

  test("a terminal close (1008) is access-lost: reason surfaced, editing stopped", () => {
    const { source, status } = setup();
    source.connect();
    source.emit("localUpdate");
    source.emit("state", "disconnected");
    source.emit("localUpdate");
    source.emit("accessDenied", "Unauthorized", 1008);

    expect(status().kind).toBe("access-lost");
    expect(status().accessLost).toEqual({ reason: "Unauthorized", code: 1008 });
    expect(status().readOnly).toBe(true);
    expect(status().unsyncedChanges).toBe(1);
  });

  test("an explicit reconnect after access-lost recovers when the new attempt syncs", () => {
    const { source, status } = setup();
    source.emit("accessDenied", "Unauthorized", 1008);
    source.emit("state", "connecting");
    expect(status().accessLost).toBeNull();
    source.connect();
    expect(status().kind).toBe("connected");
    expect(status().readOnly).toBe(false);
  });

  test("demotion flips the session read-only; promotion flips it back", () => {
    const { source, status } = setup();
    source.connect();
    source.emit("access", "read");
    expect(status().kind).toBe("read-only");
    expect(status().readOnly).toBe(true);

    source.emit("access", "write");
    expect(status().readOnly).toBe(false);
  });

  test("joining a room mid-save shows saving until its ack, never 'saved' early", () => {
    const { source, status } = setup();
    source.emit("state", "syncing");
    source.emit("unsaved", "pending"); // the join said: not settled
    source.emit("state", "synced");
    expect(status().kind).toBe("saving");

    source.emit("ack", 42);
    expect(status().kind).toBe("saved");
  });

  test("a failed save after 'Saved' takes it back, and flags the failure", () => {
    const { source, status } = setup();
    source.connect();
    source.emit("localUpdate");
    source.emit("ack", 1);
    expect(status().kind).toBe("saved");

    source.emit("unsaved", "failed");
    expect(status()).toMatchObject({ kind: "saving", saveFailing: true });

    source.emit("ack", 2); // the retry landed
    expect(status()).toMatchObject({ kind: "saved", saveFailing: false });
  });

  test("offline edits are not counted as delivered when the rejoin says read-only", () => {
    const { source, status } = setup();
    source.connect();
    source.emit("state", "disconnected");
    source.emit("localUpdate");
    source.emit("localUpdate");

    // Demoted while away: the join states read access before the handshake
    // completes, and the room drops our sync step 2.
    source.emit("state", "syncing");
    source.emit("access", "read");
    source.emit("state", "synced");

    expect(status()).toMatchObject({ kind: "read-only", readOnly: true, unsyncedChanges: 2 });
  });

  test("a promotion's fresh handshake delivers the held edits", () => {
    const { source, status } = setup();
    source.emit("access", "read");
    source.emit("localUpdate");
    source.connect();
    expect(status().unsyncedChanges).toBe(1);

    source.emit("access", "write");
    source.emit("state", "disconnected"); // the provider reconnects on promotion
    source.connect();
    expect(status()).toMatchObject({ kind: "saving", unsyncedChanges: 0 });
  });

  test("a viewer session starts read-only and catches up with an access the source already knows", () => {
    const source = new FakeSource();
    source.access = "write";
    const machine = new SessionStatusMachine(initialSessionStatusState({ readOnly: true }));
    bindSessionStatus(machine, source);
    expect(machine.getSnapshot().readOnly).toBe(false);
  });

  test("snapshots keep identity until something observable changes", () => {
    const { source, machine } = setup();
    source.connect();
    let notified = 0;
    machine.subscribe(() => notified++);
    const before = machine.getSnapshot();

    source.emit("state", "synced");
    source.emit("access", "write");
    expect(machine.getSnapshot()).toBe(before);
    expect(notified).toBe(0);
  });

  test("a graceful server restart (1012) reads as restarting, not as an error", () => {
    const { source, status } = setup();
    source.connect();
    source.emit("state", "disconnected");
    source.emit("dropped", 1012, "Server restarting");
    expect(status()).toMatchObject({ kind: "offline", serverRestarting: true });

    source.connect();
    expect(status().serverRestarting).toBe(false);
  });

  test("an ordinary drop is plain offline", () => {
    const { source, status } = setup();
    source.connect();
    source.emit("state", "disconnected");
    source.emit("dropped", 1006, "");
    expect(status()).toMatchObject({ kind: "offline", serverRestarting: false });
  });

  test("unbinding detaches every listener", () => {
    const { source, unbind } = setup();
    expect(source.listenerCount()).toBeGreaterThan(0);
    unbind();
    expect(source.listenerCount()).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Local flows: on-device persistence failing must be visible.
// ----------------------------------------------------------------------------

describe("local session status", () => {
  type LocalState = LocalPersistenceSource["state"];

  /** The `IndexeddbSyncAdapter` state surface, scripted. */
  function fakeLocal(initial: LocalState = "loading") {
    const listeners = new Set<(state: LocalState) => void>();
    const source = {
      state: initial as LocalState,
      error: null as Error | null,
      onStateChange(listener: (state: LocalState) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      move(state: LocalState, error: Error | null = null) {
        source.state = state;
        source.error = error;
        for (const listener of listeners) listener(state);
      },
    };
    return source;
  }

  test("loading and synced are quietly local", () => {
    const source = fakeLocal();
    const store = localSessionStatus(source);
    expect(store.getSnapshot().kind).toBe("local");
    source.move("synced");
    expect(store.getSnapshot().kind).toBe("local");
  });

  test("a stalled load shows slow, and clears when the load completes late", () => {
    const source = fakeLocal();
    const store = localSessionStatus(source);
    let notified = 0;
    store.subscribe(() => notified++);

    source.move("stalled", new Error("Local storage did not finish loading."));
    expect(store.getSnapshot()).toMatchObject({
      kind: "local-slow",
      localError: "Local storage did not finish loading.",
    });

    source.move("synced");
    expect(store.getSnapshot()).toMatchObject({ kind: "local", localError: null });
    expect(notified).toBe(2);
  });

  test("a store that fails to open becomes local-unsaved with its message", () => {
    const source = fakeLocal();
    const store = localSessionStatus(source);
    source.move("failed", new Error("This browser would not open local storage."));
    expect(store.getSnapshot()).toMatchObject({
      kind: "local-unsaved",
      localError: "This browser would not open local storage.",
      readOnly: false,
    });
  });

  test("an adapter already failed when the session is built starts failed", () => {
    const source = fakeLocal("failed");
    source.error = new Error("blocked");
    expect(localSessionStatus(source).getSnapshot()).toMatchObject({
      kind: "local-unsaved",
      localError: "blocked",
    });
  });
});

// ----------------------------------------------------------------------------
// Live access on the session the editor sees.
// ----------------------------------------------------------------------------

describe("withLiveAccess", () => {
  const noopSync: SyncAdapter = { kind: "local", destroy() {} };

  test("a demoted editor's document stops accepting writes", () => {
    const session = makeSession("cloud", "f", FlowDocument.createEmpty(), noopSync, false, "editor");
    const live = withLiveAccess(session, true);
    expect(live.readOnly).toBe(true);
    expect(live.role).toBe("viewer");

    live.doc.setMeta({ selectedTargetId: "uno" });
    expect(session.doc.getMeta().selectedTargetId).toBeUndefined();
    session.destroy();
  });

  test("a promoted viewer gets a writable document", () => {
    const session = makeSession("cloud", "f", FlowDocument.createEmpty(), noopSync, true, "viewer");
    const live = withLiveAccess(session, false);
    expect(live.role).toBe("editor");
    live.doc.setMeta({ selectedTargetId: "uno" });
    expect(live.doc.getMeta().selectedTargetId).toBe("uno");
    session.destroy();
  });

  test("returns the session itself when access matches, and the view never destroys", () => {
    let destroyed = 0;
    const sync: SyncAdapter = { kind: "local", destroy: () => destroyed++ };
    const session = makeSession("cloud", "f", FlowDocument.createEmpty(), sync, false, "editor");
    expect(withLiveAccess(session, false)).toBe(session);
    withLiveAccess(session, true).destroy();
    expect(destroyed).toBe(0);
    session.destroy();
  });
});

// ----------------------------------------------------------------------------
// End to end over the real provider and a fake socket.
// ----------------------------------------------------------------------------

class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.slice().buffer as ArrayBuffer });
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function syncStep2From(serverDoc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep2(encoder, serverDoc);
  return encoding.toUint8Array(encoder);
}

let flowCounter = 0;

describe("Flow Session Status over SyncProvider", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });
  afterEach(() => {
    FakeSocket.instances = [];
  });

  function connectedProvider() {
    const doc = FlowDocument.createEmpty();
    const provider = new SyncProvider({
      flowId: `status-${++flowCounter}`,
      doc: doc.doc,
      wsUrl: "wss://example.test",
      user: { id: "u", name: "Ada" },
      WebSocketPolyfill: FakeSocket as unknown as typeof WebSocket,
    });
    const machine = new SessionStatusMachine(initialSessionStatusState({ readOnly: false }));
    bindSessionStatus(machine, provider);
    const socket = FakeSocket.instances.at(-1)!;
    socket.open();
    socket.receive(syncStep2From(new Y.Doc()));
    return { doc, provider, machine, socket };
  }

  test("edits made offline are counted and cleared when the resync lands", async () => {
    const { doc, provider, machine, socket } = connectedProvider();
    expect(machine.getSnapshot().kind).toBe("connected");

    socket.serverClose(1006);
    doc.setMeta({ selectedTargetId: "uno" });
    doc.setMeta({ selectedTargetId: "nano" });
    expect(machine.getSnapshot()).toMatchObject({ kind: "offline", unsyncedChanges: 2 });

    await new Promise((r) => setTimeout(r, 260)); // y-websocket's first retry
    const retry = FakeSocket.instances.at(-1)!;
    expect(retry).not.toBe(socket);
    retry.open();
    retry.receive(syncStep2From(new Y.Doc()));
    expect(machine.getSnapshot()).toMatchObject({ kind: "saving", unsyncedChanges: 0 });

    retry.receive(new Uint8Array([MESSAGE_ACK, 7]));
    expect(machine.getSnapshot().kind).toBe("saved");
    provider.destroy();
  });

  test("a server demotion frame turns the session read-only", () => {
    const { provider, machine, socket } = connectedProvider();
    socket.receive(new Uint8Array([MESSAGE_ACCESS, 1]));
    expect(machine.getSnapshot()).toMatchObject({ kind: "read-only", readOnly: true });
    provider.destroy();
  });

  test("a denial (4403) stops retrying and reports access lost", async () => {
    const { provider, machine, socket } = connectedProvider();
    socket.serverClose(4403, "Forbidden");
    await new Promise((r) => setTimeout(r, 260));
    expect(FakeSocket.instances.length).toBe(1);
    expect(machine.getSnapshot()).toMatchObject({
      kind: "access-lost",
      accessLost: { reason: "Forbidden", code: 4403 },
    });
    provider.destroy();
  });

  test("a failed access check (1011) is a retry, not access lost", async () => {
    const { provider, machine, socket } = connectedProvider();
    socket.serverClose(1011, "Access check failed");
    expect(machine.getSnapshot()).toMatchObject({ kind: "offline", accessLost: null });
    await new Promise((r) => setTimeout(r, 260));
    expect(FakeSocket.instances.length).toBe(2);
    provider.destroy();
  });
});
