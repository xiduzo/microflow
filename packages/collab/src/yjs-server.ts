import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { RoomStore } from "./room-store";
// Shared with the client provider — the numbering is constrained by
// y-websocket's reserved range. See `protocol.ts`.
import {
  CLOSE_ACCESS_DENIED,
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
  persistDebounce?: number;
  /**
   * Ceiling on how long a dirty room may go unpersisted. `persistDebounce` is
   * a reset-on-every-update timer, so in a room where somebody is always
   * typing it never expires and the flow is never written. Once a room has
   * been dirty for this long the next update persists immediately instead of
   * re-arming. See `schedulePersist`.
   */
  persistMaxWait?: number;
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
  persistTimeout: ReturnType<typeof setTimeout> | null;
  lastPersistedAt: number;
  isDirty: boolean;
  /**
   * When the room first became dirty since the last successful persist, or
   * `null` when clean. `schedulePersist` uses it to enforce `persistMaxWait`
   * against a debounce timer that would otherwise re-arm forever.
   */
  firstDirtyAt: number | null;
};

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
  /**
   * Rooms being torn down, keyed by flow id. Cleanup persists before it
   * destroys, so a join arriving mid-teardown must wait for that write to
   * land — otherwise it loads a stale document from the store and the last
   * edits of the previous session are lost.
   */
  private roomsClosing = new Map<string, Promise<void>>();
  private readonly store: RoomStore;
  private persistDebounce: number;
  private persistMaxWait: number;
  private messageRateLimit: number;
  private maxMessageBytes: number;
  private maxBufferedBytes: number;

  constructor(options: YjsServerOptions) {
    this.store = options.store;
    this.persistDebounce = options.persistDebounce ?? 2000;
    this.persistMaxWait = options.persistMaxWait ?? 10_000;
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
    const room = await this.getOrCreateRoom(flowId);
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
      void this.cleanupRoom(connection.flowId, room);
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
    const room = this.rooms.get(flowId);
    if (!room) return;

    if (room.persistTimeout) clearTimeout(room.persistTimeout);
    // Unregister first: `leave()` is a no-op for an unknown room, so closing
    // the connections below cannot trigger the flush-on-last-disconnect path.
    this.rooms.delete(flowId);
    for (const connection of Array.from(room.connections)) {
      connection.close();
      connection.socket.close();
    }
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

    const syncMessageType = syncProtocol.readSyncMessage(
      decoder,
      encoder,
      room.doc,
      connection, // Use the handle as origin to track sender
    );

    // Send response if needed (sync step 2)
    if (encoding.length(encoder) > 1) {
      connection.socket.send(encoding.toUint8Array(encoder));
    }

    // If we received an update, schedule persistence
    if (syncMessageType === syncProtocol.messageYjsUpdate) {
      room.isDirty = true;
      this.schedulePersist(connection.flowId, room);
    }
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
   * Arm (or re-arm) the debounced persist for a dirty room.
   *
   * The debounce is reset-on-every-update, which alone means a room with
   * continuous activity — a large group mid-session is exactly that — never
   * reaches its timeout and is never written. `persistMaxWait` bounds it: once
   * the room has been dirty that long, persist now rather than re-arming.
   */
  private schedulePersist(flowId: string, room: Room): void {
    room.firstDirtyAt ??= Date.now();

    if (Date.now() - room.firstDirtyAt >= this.persistMaxWait) {
      if (room.persistTimeout) {
        clearTimeout(room.persistTimeout);
        room.persistTimeout = null;
      }
      void this.persistRoom(flowId, room);
      return;
    }

    if (room.persistTimeout) {
      clearTimeout(room.persistTimeout);
    }

    room.persistTimeout = setTimeout(async () => {
      room.persistTimeout = null;
      await this.persistRoom(flowId, room);
    }, this.persistDebounce);
  }

  private async persistRoom(flowId: string, room: Room): Promise<void> {
    if (!room.isDirty) return;

    // Clear the flags before the await, not after: an update arriving while
    // `save` is in flight must leave the room dirty so it is written again,
    // rather than being cleared by this call's completion.
    room.isDirty = false;
    room.firstDirtyAt = null;

    try {
      await this.store.save(flowId, Y.encodeStateAsUpdate(room.doc));

      room.lastPersistedAt = Date.now();

      // Notify clients of successful persistence
      this.broadcastAck(room, room.lastPersistedAt);

      console.log(`[YJS] Persisted room ${flowId}`);
    } catch (error) {
      // Put the room back in the dirty state so the next update — or the
      // final flush on teardown — retries the write instead of assuming it
      // landed.
      room.isDirty = true;
      room.firstDirtyAt ??= Date.now();
      console.error(`[YJS] Failed to persist room ${flowId}:`, error);
    }
  }

  /**
   * Flush and tear down an empty room.
   *
   * Deregistration happens *first*, before the final persist is awaited: a
   * join arriving during that await must not be handed a room whose doc is
   * about to be destroyed. The teardown is published on `roomsClosing` so the
   * replacement load waits for this write rather than reading a stale
   * document out from under it.
   */
  private cleanupRoom(flowId: string, room: Room): Promise<void> {
    if (room.persistTimeout) {
      clearTimeout(room.persistTimeout);
      room.persistTimeout = null;
    }

    this.rooms.delete(flowId);

    const closing = (async () => {
      if (room.isDirty) {
        await this.persistRoom(flowId, room);
      }
      room.awareness.destroy();
      room.doc.destroy();
      console.log(`[YJS] Cleaned up room ${flowId}`);
    })().finally(() => {
      // Only retract our own entry — a later teardown of a newer room for the
      // same flow may already have replaced it.
      if (this.roomsClosing.get(flowId) === closing) this.roomsClosing.delete(flowId);
    });

    this.roomsClosing.set(flowId, closing);
    return closing;
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
    // A teardown for this flow may still be flushing its final state. Load
    // after it lands, or we read a document that is one session out of date.
    await this.roomsClosing.get(flowId)?.catch(() => {});

    const persisted = await this.store.load(flowId);

    // Create Y.Doc
    const doc = new Y.Doc();
    if (persisted) {
      Y.applyUpdate(doc, persisted);
    } else {
      // Initialize empty structure
      doc.getMap("meta");
      doc.getMap("nodes");
      doc.getMap("edges");
    }

    // Create awareness
    const awareness = new awarenessProtocol.Awareness(doc);

    const room: Room = {
      doc,
      awareness,
      connections: new Set(),
      persistTimeout: null,
      lastPersistedAt: Date.now(),
      isDirty: false,
      firstDirtyAt: null,
    };

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

  async forcePersist(flowId: string): Promise<void> {
    const room = this.rooms.get(flowId);
    if (room) {
      room.isDirty = true;
      await this.persistRoom(flowId, room);
    }
  }
}
