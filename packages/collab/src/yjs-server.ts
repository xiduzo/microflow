import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { RoomStore } from "./room-store";
import { RoomPersistence, type PersistPolicy } from "./room-persistence";
import { upgradeLegacyNodes } from "./schema";
// Shared with the client provider — the numbering is constrained by
// y-websocket's reserved range. See `protocol.ts`.
import {
  CLOSE_ACCESS_DENIED,
  CLOSE_SERVICE_RESTART,
  MESSAGE_ACK,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SYNC,
} from "./protocol";

// ============================================================================
// Types
// ============================================================================

export type YjsServerOptions = {
  /** Where room documents live. Required — see `RoomStore`. */
  store: RoomStore;
  /** Quiet period after the last change before a room is persisted. */
  persistDebounce?: number;
  /**
   * Ceiling on how long a dirty room may go unpersisted. `persistDebounce` is
   * a reset-on-every-update timer, so in a room where somebody is always
   * typing it never expires and the flow is never written. Once a room has
   * been dirty for this long it is persisted whether or not edits are still
   * arriving. See `RoomPersistence`.
   */
  persistMaxWait?: number;
  /** First backoff delay after a failed persist; doubles per failure. */
  persistRetryBase?: number;
  /** Cap on the backoff delay between persist retries. */
  persistRetryMax?: number;
  /** Inbound frames allowed per connection per second before dropping. */
  messageRateLimit?: number;
  /** Largest inbound frame accepted, in bytes. */
  maxMessageBytes?: number;
  /**
   * Close a connection whose socket has buffered more than this many bytes.
   * A client that cannot keep up with the broadcast must resync from scratch;
   * buffering for it indefinitely costs the whole room. Requires the
   * transport to report `bufferedAmount` — without it, no limit is enforced.
   */
  maxBufferedBytes?: number;
};

/** The socket a room writes to. Supplied by the transport (see `handler.ts`). */
export type Connection = {
  send: (data: Uint8Array) => void;
  /**
   * Close the socket. A code in 4400–4499 tells `WebsocketProvider` the answer
   * will not change and stops it reconnecting — see `CLOSE_ACCESS_DENIED`.
   */
  close: (code?: number, reason?: string) => void;
  /**
   * Bytes queued on the socket but not yet flushed to the network, when the
   * transport can report it. Read before every broadcast so a stalled peer is
   * dropped rather than buffered without bound.
   */
  bufferedAmount?: () => number;
};

/**
 * What a user may do with a room.
 *
 * Deliberately not `FlowRole`: the collab package knows about read and write,
 * not about owners and collaborators. The caller resolves the role and maps
 * it here, so the two vocabularies stay on their own sides of the seam.
 */
export type Access = "none" | "read" | "write";

/**
 * A live attachment to a room, handed back by `YjsServer.join()`.
 *
 * This is the whole interface a transport needs, and the only way to reach a
 * room: bytes go in through `receive`, the attachment ends with `close`.
 * There is no way to address a room by id and a socket you claim to own, so a
 * caller cannot accidentally present an unregistered connection and be
 * silently treated as a stranger.
 */
export type RoomConnection = {
  readonly flowId: string;
  readonly userId: string;
  /** Whether inbound document writes from this connection are applied. */
  readonly canWrite: boolean;
  receive(data: Uint8Array): void;
  close(): void;
};

type Room = {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  connections: Set<RoomConnectionImpl>;
  /** Dirty tracking, debounce and retry — see `RoomPersistence`. */
  persistence: RoomPersistence;
  /** Set when the doc is destroyed, so a join that raced teardown retries. */
  destroyed: boolean;
};

/**
 * Thrown by `join()` once `shutdown()` has begun. The transport closes the
 * socket with `CLOSE_SERVICE_RESTART` so the client reconnects elsewhere.
 */
export class RoomServerShuttingDown extends Error {
  constructor() {
    super("Room server is shutting down");
    this.name = "RoomServerShuttingDown";
  }
}

/**
 * Thrown by `join()` for a flow `dropRoom()` discarded — the flow was deleted,
 * possibly while this join was past its access check. The transport closes
 * with `CLOSE_FLOW_GONE`, a terminal code, so the client stops reconnecting.
 */
export class RoomGone extends Error {
  constructor(readonly flowId: string) {
    super(`Flow ${flowId} no longer exists`);
    this.name = "RoomGone";
  }
}

// ============================================================================
// RoomConnection
// ============================================================================

class RoomConnectionImpl implements RoomConnection {
  /** Awareness client IDs seen from this connection, cleared on close. */
  readonly awarenessClientIds = new Set<number>();
  canWrite: boolean;
  private closed = false;

  /**
   * Token bucket over inbound frames. One contributor with a runaway loop (or
   * a hostile client) must not be able to spend the whole room's budget, so
   * the limit is per connection and enforced before any decoding happens.
   * Refills continuously at `rate` tokens/second, capped at `rate`.
   */
  private tokens: number;
  private lastRefillAt = Date.now();

  constructor(
    readonly flowId: string,
    readonly userId: string,
    readonly socket: Connection,
    canWrite: boolean,
    private readonly server: YjsServer,
    private readonly rate: number,
    private readonly maxMessageBytes: number,
  ) {
    this.canWrite = canWrite;
    this.tokens = rate;
  }

  receive(data: Uint8Array): void {
    if (this.closed) return;
    if (data.byteLength > this.maxMessageBytes) {
      console.warn(
        `[YJS] Dropping ${data.byteLength}B frame from ${this.userId} on ${this.flowId} (limit ${this.maxMessageBytes}B)`,
      );
      return;
    }
    if (!this.takeToken()) return;
    this.server.receive(this, data);
  }

  /** Refill by elapsed time, then spend one token. False when starved. */
  private takeToken(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.lastRefillAt) / 1000) * this.rate);
    this.lastRefillAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.leave(this);
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

// ============================================================================
// YjsServer - Server-side room management
// ============================================================================

export class YjsServer {
  private rooms = new Map<string, Room>();
  /**
   * Rooms being loaded, keyed by flow id. `getOrCreateRoom` is async — it
   * awaits `store.load` between the "does this room exist?" check and the
   * `rooms.set` — so without this two simultaneous joins would each build a
   * `Y.Doc` and the second would overwrite the first in `rooms`. The losing
   * room's connections are then unreachable: `receive` looks the room up by
   * flow id, finds the surviving room, sees the connection is not in its set
   * and drops the message silently. Memoizing the in-flight load makes every
   * concurrent join await the same room.
   */
  private roomsLoading = new Map<string, Promise<Room>>();
  private readonly store: RoomStore;
  private readonly persistPolicy: PersistPolicy;
  private messageRateLimit: number;
  private maxMessageBytes: number;
  private maxBufferedBytes: number;
  private shuttingDown = false;
  /** Flows discarded by `dropRoom()`; never loaded again by this process. */
  private readonly droppedFlows = new Set<string>();

  constructor(options: YjsServerOptions) {
    this.store = options.store;
    this.persistPolicy = {
      debounceMs: options.persistDebounce ?? 2000,
      maxWaitMs: options.persistMaxWait ?? 10_000,
      retryBaseMs: options.persistRetryBase ?? 1000,
      retryMaxMs: options.persistRetryMax ?? 30_000,
    };
    this.messageRateLimit = options.messageRateLimit ?? 240;
    this.maxMessageBytes = options.maxMessageBytes ?? 8 * 1024 * 1024;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024;
  }

  // --------------------------------------------------------------------------
  // Connection Handling
  // --------------------------------------------------------------------------

  /**
   * Attach a socket to a room and return the handle that drives it.
   *
   * The caller is responsible for having authorized `userId` on `flowId`
   * first — `canWrite` is required (not defaulted) so no caller can grant
   * write access by omission.
   */
  async join(
    flowId: string,
    socket: Connection,
    userId: string,
    canWrite: boolean,
  ): Promise<RoomConnection> {
    if (this.shuttingDown) throw new RoomServerShuttingDown();
    let room = await this.getOrCreateRoom(flowId);
    // The room was live when we looked, but an idle room is destroyed as soon
    // as its last save lands — which can happen while this join was suspended.
    // Look again rather than attach to a destroyed doc.
    while (room.destroyed) room = await this.getOrCreateRoom(flowId);
    if (this.shuttingDown) throw new RoomServerShuttingDown();
    const connection = new RoomConnectionImpl(
      flowId,
      userId,
      socket,
      canWrite,
      this,
      this.messageRateLimit,
      this.maxMessageBytes,
    );

    room.connections.add(connection);
    console.log(`[YJS] Room ${flowId}: ${room.connections.size} connection(s)`);

    // Send initial sync (step 1)
    this.sendSyncStep1(socket, room.doc);

    // Send current awareness state
    this.sendAwarenessState(socket, room.awareness);

    return connection;
  }

  /** Detach a connection. Called by `RoomConnection.close()`. */
  leave(connection: RoomConnectionImpl): void {
    const room = this.rooms.get(connection.flowId);
    if (!room) return;

    // Remove all awareness states associated with this connection
    if (connection.awarenessClientIds.size > 0) {
      const clientIds = Array.from(connection.awarenessClientIds);
      console.log(`[YJS] Removing awareness for client IDs: ${clientIds.join(", ")}`);
      awarenessProtocol.removeAwarenessStates(room.awareness, clientIds, null);
    }

    room.connections.delete(connection);
    console.log(
      `[YJS] Room ${connection.flowId}: ${room.connections.size} connection(s) after disconnect`,
    );

    if (room.connections.size === 0) {
      this.releaseIdleRoom(connection.flowId, room);
    }
  }

  // --------------------------------------------------------------------------
  // Access
  // --------------------------------------------------------------------------

  /**
   * Apply an access change to every live connection `userId` holds on
   * `flowId`. Without this a role resolved at connect time outlives the grant
   * it came from: a removed collaborator keeps writing until they reconnect.
   *
   * `"none"` closes their sockets, `"read"` drops the write bit, `"write"`
   * restores it. A no-op when the room isn't loaded — a later `join` resolves
   * access again from scratch.
   */
  setAccess(flowId: string, userId: string, access: Access): void {
    const room = this.rooms.get(flowId);
    if (!room) return;

    for (const connection of Array.from(room.connections)) {
      if (connection.userId !== userId) continue;

      if (access === "none") {
        console.log(`[YJS] Room ${flowId}: revoking ${userId}`);
        connection.close();
        // Non-retryable: a removed collaborator must stop reconnecting rather
        // than back off and try again forever.
        connection.socket.close(CLOSE_ACCESS_DENIED, "Access revoked");
        continue;
      }
      connection.canWrite = access === "write";
    }
  }

  /**
   * Close a room and discard it without persisting — for a flow that no
   * longer exists. A plain cleanup would flush the doc back to a deleted row.
   */
  dropRoom(flowId: string): void {
    // Remembered even when no room is loaded: a join may be past its access
    // check with the load still in flight, and would otherwise build a fresh,
    // empty room for the deleted flow. Flow ids are never reused, so the set
    // only grows by one id per deletion in this process.
    this.droppedFlows.add(flowId);
    const room = this.rooms.get(flowId);
    if (!room) return;

    room.persistence.stop();
    // Unregister first: `leave()` is a no-op for an unknown room, so closing
    // the connections below cannot trigger the flush-on-last-disconnect path.
    this.rooms.delete(flowId);
    for (const connection of Array.from(room.connections)) {
      connection.close();
      connection.socket.close();
    }
    room.destroyed = true;
    room.awareness.destroy();
    room.doc.destroy();
    console.log(`[YJS] Dropped room ${flowId}`);
  }

  // --------------------------------------------------------------------------
  // Message Handling
  // --------------------------------------------------------------------------

  /** Handle bytes from a connection. Called by `RoomConnection.receive()`. */
  receive(connection: RoomConnectionImpl, data: Uint8Array): void {
    const room = this.rooms.get(connection.flowId);
    if (!room || !room.connections.has(connection)) return;

    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC:
        this.handleSyncMessage(room, connection, decoder);
        break;
      case MESSAGE_AWARENESS:
        this.handleAwarenessMessage(room, connection, decoder);
        break;
      case MESSAGE_QUERY_AWARENESS:
        // Part of the y-websocket protocol: "tell me who else is here".
        // The provider only sends it over its cross-tab BroadcastChannel
        // today, but answering it costs nothing and keeps us honest against
        // the protocol rather than against one client's current behaviour.
        this.sendAwarenessState(connection.socket, room.awareness);
        break;
    }
  }

  private handleSyncMessage(
    room: Room,
    connection: RoomConnectionImpl,
    decoder: decoding.Decoder,
  ): void {
    // Read-only connections may only ask for our state (step 1). Step 2 and
    // update messages both write into the doc, so drop them.
    if (!connection.canWrite && decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) {
      return;
    }

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);

    syncProtocol.readSyncMessage(
      decoder,
      encoder,
      room.doc,
      connection, // Use the handle as origin to track sender
    );

    // Send response if needed (sync step 2)
    if (encoding.length(encoder) > 1) {
      connection.socket.send(encoding.toUint8Array(encoder));
    }

    // Persistence is not decided here. Both step 2 (a reconnecting client's
    // offline edits) and update frames write into the doc; `RoomPersistence`
    // watches the doc itself, so whichever carried the edit, it is saved.
  }

  private handleAwarenessMessage(
    room: Room,
    connection: RoomConnectionImpl,
    decoder: decoding.Decoder,
  ): void {
    const update = decoding.readVarUint8Array(decoder);

    awarenessProtocol.applyAwarenessUpdate(
      room.awareness,
      this.stampAwarenessIdentity(update, connection),
      connection,
    );
  }

  /**
   * Rewrite `user.id` on every state in an awareness update to the
   * authenticated user behind the connection, and track the client IDs it
   * carries so they can be cleared on disconnect.
   *
   * Presence is client-authored — without this a Viewer can present
   * themselves as the Owner in cursors and the collaborator panel. The wire
   * format is `varUint(count)` then, per client, `varUint(clientID)`,
   * `varUint(clock)`, `varString(JSON state)`; a removed state is `null`.
   */
  private stampAwarenessIdentity(update: Uint8Array, connection: RoomConnectionImpl): Uint8Array {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, count);

    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const stateJson = decoding.readVarString(decoder);

      let state: unknown = null;
      try {
        state = JSON.parse(stateJson);
      } catch {
        state = null;
      }

      if (state === null) {
        connection.awarenessClientIds.delete(clientId);
      } else {
        connection.awarenessClientIds.add(clientId);
        const user = (state as { user?: Record<string, unknown> }).user;
        if (user && typeof user === "object") {
          user.id = connection.userId;
        }
      }

      encoding.writeVarUint(encoder, clientId);
      encoding.writeVarUint(encoder, clock);
      encoding.writeVarString(encoder, JSON.stringify(state));
    }

    return encoding.toUint8Array(encoder);
  }

  // --------------------------------------------------------------------------
  // Sending Messages
  // --------------------------------------------------------------------------

  private sendSyncStep1(socket: Connection, doc: Y.Doc): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    socket.send(encoding.toUint8Array(encoder));
  }

  private sendAwarenessState(socket: Connection, awareness: awarenessProtocol.Awareness): void {
    const states = Array.from(awareness.getStates().keys());
    if (states.length === 0) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, states),
    );
    socket.send(encoding.toUint8Array(encoder));
  }

  /**
   * Fan a message out to the room, skipping `except` (the origin).
   *
   * A peer whose socket has fallen too far behind is closed rather than
   * buffered: the send queue is server memory, and one stalled client in a
   * busy room can consume it without bound. Dropping is safe — the client
   * reconnects and resyncs from scratch, which is what sync-step-1 is for.
   */
  private broadcast(room: Room, message: Uint8Array, except: unknown): void {
    let stalled: RoomConnectionImpl[] | null = null;

    for (const connection of room.connections) {
      if (connection === except) continue;
      try {
        const buffered = connection.socket.bufferedAmount?.() ?? 0;
        if (buffered > this.maxBufferedBytes) {
          (stalled ??= []).push(connection);
          continue;
        }
        connection.socket.send(message);
      } catch {
        // Connection might be closed
      }
    }

    // Closing mutates `room.connections`, so it happens after the iteration.
    for (const connection of stalled ?? []) {
      console.warn(
        `[YJS] Room ${connection.flowId}: dropping ${connection.userId} — send buffer over ${this.maxBufferedBytes}B`,
      );
      connection.close();
      try {
        connection.socket.close();
      } catch {
        // Already gone
      }
    }
  }

  private broadcastAck(room: Room, version: number): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_ACK);
    encoding.writeVarUint(encoder, version);
    this.broadcast(room, encoding.toUint8Array(encoder), null);
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  /**
   * The last connection left. Destroy the room once everything it accepted is
   * in the store — never before.
   *
   * A settled room goes now. An unsettled one is flushed and stays registered
   * (and in memory) until a save lands: `RoomPersistence` keeps retrying with
   * backoff, and `onRoomPersisted` finishes the teardown. A join arriving in
   * the meantime simply gets this room back, with its unsaved edits intact,
   * instead of loading an older document from the store.
   */
  private releaseIdleRoom(flowId: string, room: Room): void {
    if (room.persistence.isSettled) {
      this.destroyRoom(flowId, room);
      return;
    }
    room.persistence.flush().catch(() => {
      console.error(
        `[YJS] Room ${flowId}: final persist failed with no one connected; ` +
          `holding the document in memory until a retry succeeds`,
      );
    });
  }

  /** A save landed: acknowledge it, and finish an idle room's teardown. */
  private onRoomPersisted(flowId: string, room: Room, at: number): void {
    if (room.destroyed) return;
    this.broadcastAck(room, at);
    console.log(`[YJS] Persisted room ${flowId}`);
    if (room.connections.size === 0 && room.persistence.isSettled) {
      this.destroyRoom(flowId, room);
    }
  }

  /** Tear a settled room down. Synchronous, so no join can interleave. */
  private destroyRoom(flowId: string, room: Room): void {
    if (this.rooms.get(flowId) === room) this.rooms.delete(flowId);
    room.destroyed = true;
    room.persistence.stop();
    room.awareness.destroy();
    room.doc.destroy();
    console.log(`[YJS] Cleaned up room ${flowId}`);
  }

  // --------------------------------------------------------------------------
  // Room Management
  // --------------------------------------------------------------------------

  /**
   * The room for `flowId`, loading it if this is the first join.
   *
   * Deliberately *not* `async`: the synchronous prefix — the `rooms` lookup
   * and the `roomsLoading` memo — must run to completion before any other
   * join can interleave. An `async` function would suspend at its first
   * `await` and reopen the window this exists to close.
   */
  private getOrCreateRoom(flowId: string): Promise<Room> {
    if (this.droppedFlows.has(flowId)) return Promise.reject(new RoomGone(flowId));
    const live = this.rooms.get(flowId);
    if (live) return Promise.resolve(live);

    const loading = this.roomsLoading.get(flowId);
    if (loading) return loading;

    const pending = this.loadRoom(flowId).finally(() => {
      this.roomsLoading.delete(flowId);
    });
    this.roomsLoading.set(flowId, pending);
    return pending;
  }

  private async loadRoom(flowId: string): Promise<Room> {
    // No wait for a previous teardown is needed: a room stays registered until
    // its document is in the store, so if we got here the store is current.
    const persisted = await this.store.load(flowId);

    // Both can begin while the load is in flight. Registering anyway would
    // leave a room nobody drains (shutdown already took its snapshot) or one
    // for a deleted flow (whose saves match no row, acked as if they landed).
    // Not registering loses nothing: the store still holds what was loaded.
    if (this.shuttingDown) throw new RoomServerShuttingDown();
    if (this.droppedFlows.has(flowId)) throw new RoomGone(flowId);

    const doc = new Y.Doc();
    if (persisted) {
      Y.applyUpdate(doc, persisted);
    } else {
      // Initialize empty structure
      doc.getMap("meta");
      doc.getMap("nodes");
      doc.getMap("edges");
    }

    const room: Room = {
      doc,
      awareness: new awarenessProtocol.Awareness(doc),
      connections: new Set(),
      destroyed: false,
      // After the stored state is applied (loading is not an edit), before the
      // migration below (which is, and must be written back).
      persistence: new RoomPersistence(flowId, doc, this.store, this.persistPolicy, (at) =>
        this.onRoomPersisted(flowId, room, at),
      ),
    };
    const { awareness } = room;

    if (persisted) {
      // The load boundary is the only place the pre-ADR-0019 node shape is
      // handled. Bringing the document forward here means every reader —
      // clients included, since they sync from this doc — sees one shape, and
      // `FlowDocument` needs no compatibility branch on its hot path.
      // A migration is a document change, so `RoomPersistence` sees it and
      // writes it back: the upgrade happens once, not on every load.
      const migrated = upgradeLegacyNodes(doc);
      if (migrated > 0) {
        console.log(`[YJS] Room ${flowId}: upgraded ${migrated} node(s) to the nested shape`);
      }
    }

    // Set up doc update broadcasting
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(room, encoding.toUint8Array(encoder), origin);
    });

    // Set up awareness broadcasting
    awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changedClients = [...added, ...updated, ...removed];
        if (changedClients.length === 0) return;

        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients),
        );
        this.broadcast(room, encoding.toUint8Array(encoder), origin);
      },
    );

    this.rooms.set(flowId, room);
    console.log(`[YJS] Created room ${flowId}`);

    return room;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  getRoomCount(): number {
    return this.rooms.size;
  }

  getConnectionCount(flowId: string): number {
    return this.rooms.get(flowId)?.connections.size ?? 0;
  }

  /**
   * The document as the live room holds it, or `null` when no room is loaded
   * for `flowId` (the store is then current).
   *
   * Readers that serve or snapshot a flow — `flow.get`, `flow.publish` — use
   * this ahead of the stored copy, which lags a live room by up to the
   * persist ceiling. A room awaiting a successful save is still loaded, so
   * its unsaved edits are visible here too.
   */
  currentState(flowId: string): Uint8Array | null {
    const room = this.rooms.get(flowId);
    return room ? Y.encodeStateAsUpdate(room.doc) : null;
  }

  /**
   * Stop taking edits and write every room to the store, for process exit.
   *
   * Every connection is closed first with `CLOSE_SERVICE_RESTART` (retryable:
   * the client reconnects to the next instance and re-sends anything the
   * store lacks as sync step 2), so nothing is accepted after its room's last
   * save. Joins from here on are refused. Resolves with the flows still
   * unsaved when `timeoutMs` ran out — empty is a clean shutdown.
   */
  async shutdown(timeoutMs = 10_000): Promise<{ unsaved: string[] }> {
    this.shuttingDown = true;
    const deadline = Date.now() + timeoutMs;
    const rooms = Array.from(this.rooms.entries());

    for (const [, room] of rooms) {
      for (const connection of Array.from(room.connections)) {
        connection.close();
        try {
          connection.socket.close(CLOSE_SERVICE_RESTART, "Server restarting");
        } catch {
          // Already gone
        }
      }
    }

    const unsettled = () =>
      rooms.filter(([, room]) => !room.destroyed && !room.persistence.isSettled);
    let pending = unsettled();
    while (pending.length > 0 && Date.now() < deadline) {
      await withDeadline(
        Promise.allSettled(pending.map(([, room]) => room.persistence.flush())),
        deadline,
      );
      pending = unsettled();
      // A failing store: pause briefly rather than spin on it.
      if (pending.length > 0) await withDeadline(sleep(250), deadline);
    }

    const unsaved = pending.map(([flowId]) => flowId);
    if (unsaved.length > 0) {
      console.error(
        `[YJS] Shutdown: ${unsaved.length} room(s) NOT persisted; edits since their last save are lost: ${unsaved.join(", ")}`,
      );
    } else {
      console.log(`[YJS] Shutdown: all ${rooms.length} room(s) persisted`);
    }
    return { unsaved };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Settle when `work` does or when `deadline` (epoch ms) passes, whichever is first. */
async function withDeadline(work: Promise<unknown>, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
    }),
  ]);
  clearTimeout(timer);
}
