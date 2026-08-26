import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { RoomStore } from "./room-store";

// ============================================================================
// Constants
// ============================================================================

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_ACK = 2;

// ============================================================================
// Types
// ============================================================================

export type YjsServerOptions = {
  /** Where room documents live. Required — see `RoomStore`. */
  store: RoomStore;
  /** Quiet period after the last change before a room is persisted. */
  persistDebounce?: number;
  /**
   * Hard upper bound between a room going dirty and it being persisted, so
   * sustained editing can't postpone persistence indefinitely.
   */
  persistMaxWait?: number;
};

/** The socket a room writes to. Supplied by the transport (see `handler.ts`). */
export type Connection = {
  send: (data: Uint8Array) => void;
  close: () => void;
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
  /** When the room first went dirty since the last persist; drives the max-wait. */
  dirtySince: number | null;
  lastPersistedAt: number;
  isDirty: boolean;
};

// ============================================================================
// RoomConnection
// ============================================================================

class RoomConnectionImpl implements RoomConnection {
  /** Awareness client IDs seen from this connection, cleared on close. */
  readonly awarenessClientIds = new Set<number>();
  canWrite: boolean;
  private closed = false;

  constructor(
    readonly flowId: string,
    readonly userId: string,
    readonly socket: Connection,
    canWrite: boolean,
    private readonly server: YjsServer,
  ) {
    this.canWrite = canWrite;
  }

  receive(data: Uint8Array): void {
    if (this.closed) return;
    this.server.receive(this, data);
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
  private readonly store: RoomStore;
  private persistDebounce: number;
  private persistMaxWait: number;

  constructor(options: YjsServerOptions) {
    this.store = options.store;
    this.persistDebounce = options.persistDebounce ?? 2000;
    this.persistMaxWait = Math.max(
      this.persistDebounce,
      options.persistMaxWait ?? 10_000,
    );
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
    const connection = new RoomConnectionImpl(flowId, userId, socket, canWrite, this);

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
        connection.socket.close();
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

  private broadcast(room: Room, message: Uint8Array, except: unknown): void {
    for (const connection of room.connections) {
      if (connection === except) continue;
      try {
        connection.socket.send(message);
      } catch {
        // Connection might be closed
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
   * Persist after `persistDebounce` of quiet, but never later than
   * `persistMaxWait` after the room first went dirty — sustained editing
   * pushes the quiet-period timer forever, so the deadline is what bounds
   * how much unsaved work a room can hold.
   */
  private schedulePersist(flowId: string, room: Room): void {
    if (room.persistTimeout) {
      clearTimeout(room.persistTimeout);
    }
    if (room.dirtySince === null) {
      room.dirtySince = Date.now();
    }

    const untilDeadline = room.dirtySince + this.persistMaxWait - Date.now();
    const wait = Math.max(0, Math.min(this.persistDebounce, untilDeadline));

    room.persistTimeout = setTimeout(async () => {
      room.persistTimeout = null;
      await this.persistRoom(flowId, room);
    }, wait);
  }

  private async persistRoom(flowId: string, room: Room): Promise<void> {
    if (!room.isDirty) return;

    try {
      await this.store.save(flowId, Y.encodeStateAsUpdate(room.doc));

      room.isDirty = false;
      room.dirtySince = null;
      room.lastPersistedAt = Date.now();

      // Notify clients of successful persistence
      this.broadcastAck(room, room.lastPersistedAt);

      console.log(`[YJS] Persisted room ${flowId}`);
    } catch (error) {
      console.error(`[YJS] Failed to persist room ${flowId}:`, error);
    }
  }

  private async cleanupRoom(flowId: string, room: Room): Promise<void> {
    // Clear any pending persist timeout
    if (room.persistTimeout) {
      clearTimeout(room.persistTimeout);
    }

    // Final persist before cleanup
    if (room.isDirty) {
      await this.persistRoom(flowId, room);
    }

    // Destroy awareness and doc
    room.awareness.destroy();
    room.doc.destroy();

    // Remove from rooms map
    this.rooms.delete(flowId);
    console.log(`[YJS] Cleaned up room ${flowId}`);
  }

  // --------------------------------------------------------------------------
  // Room Management
  // --------------------------------------------------------------------------

  private async getOrCreateRoom(flowId: string): Promise<Room> {
    let room = this.rooms.get(flowId);
    if (room) return room;

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

    room = {
      doc,
      awareness,
      connections: new Set(),
      persistTimeout: null,
      dirtySince: null,
      lastPersistedAt: Date.now(),
      isDirty: false,
    };

    // Set up doc update broadcasting
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(room!, encoding.toUint8Array(encoder), origin);
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
        this.broadcast(room!, encoding.toUint8Array(encoder), origin);
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
