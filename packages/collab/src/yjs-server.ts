import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { db } from "@microflow/db";
import { flow } from "@microflow/db/schema/flow";
import { eq } from "drizzle-orm";

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
  persistDebounce?: number;
};

export type Connection = {
  send: (data: Uint8Array) => void;
  close: () => void;
};

type ConnectionInfo = {
  awarenessClientIds: Set<number>; // Track all awareness client IDs from this connection
  userId: string;
};

type Room = {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  connections: Map<Connection, ConnectionInfo>;
  persistTimeout: ReturnType<typeof setTimeout> | null;
  lastPersistedAt: number;
  isDirty: boolean;
};

// ============================================================================
// YjsServer - Server-side room management
// ============================================================================

export class YjsServer {
  private rooms = new Map<string, Room>();
  private persistDebounce: number;

  constructor(options: YjsServerOptions = {}) {
    this.persistDebounce = options.persistDebounce ?? 2000;
  }

  // --------------------------------------------------------------------------
  // Connection Handling
  // --------------------------------------------------------------------------

  async handleConnection(
    flowId: string,
    connection: Connection,
    userId: string,
  ): Promise<() => void> {
    const room = await this.getOrCreateRoom(flowId);

    room.connections.set(connection, {
      awarenessClientIds: new Set(),
      userId,
    });
    console.log(`[YJS] Room ${flowId}: ${room.connections.size} connection(s)`);

    // Send initial sync (step 1)
    this.sendSyncStep1(connection, room.doc);

    // Send current awareness state
    this.sendAwarenessState(connection, room.awareness);

    // Return cleanup function
    return () => {
      const connInfo = room.connections.get(connection);

      // Remove all awareness states associated with this connection
      if (connInfo && connInfo.awarenessClientIds.size > 0) {
        const clientIds = Array.from(connInfo.awarenessClientIds);
        console.log(`[YJS] Removing awareness for client IDs: ${clientIds.join(", ")}`);
        awarenessProtocol.removeAwarenessStates(room.awareness, clientIds, null);
      }

      room.connections.delete(connection);
      console.log(`[YJS] Room ${flowId}: ${room.connections.size} connection(s) after disconnect`);

      // Clean up room if empty
      if (room.connections.size === 0) {
        this.cleanupRoom(flowId, room);
      }
    };
  }

  // --------------------------------------------------------------------------
  // Message Handling
  // --------------------------------------------------------------------------

  handleMessage(flowId: string, connection: Connection, data: Uint8Array): void {
    const room = this.rooms.get(flowId);
    if (!room) return;

    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC:
        this.handleSyncMessage(flowId, room, connection, decoder);
        break;
      case MESSAGE_AWARENESS:
        this.handleAwarenessMessage(room, connection, decoder);
        break;
    }
  }

  private handleSyncMessage(
    flowId: string,
    room: Room,
    connection: Connection,
    decoder: decoding.Decoder,
  ): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);

    const syncMessageType = syncProtocol.readSyncMessage(
      decoder,
      encoder,
      room.doc,
      connection, // Use connection as origin to track sender
    );

    // Send response if needed (sync step 2)
    if (encoding.length(encoder) > 1) {
      connection.send(encoding.toUint8Array(encoder));
    }

    // If we received an update, schedule persistence
    if (syncMessageType === syncProtocol.messageYjsUpdate) {
      room.isDirty = true;
      this.schedulePersist(flowId, room);
    }
  }

  private handleAwarenessMessage(
    room: Room,
    connection: Connection,
    decoder: decoding.Decoder,
  ): void {
    const update = decoding.readVarUint8Array(decoder);

    // Manually decode the awareness update to extract client IDs
    // Awareness update format: [length, ...clientIDs, ...states]
    const updateDecoder = decoding.createDecoder(update);
    const len = decoding.readVarUint(updateDecoder);

    const connInfo = room.connections.get(connection);
    if (connInfo) {
      for (let i = 0; i < len; i++) {
        const clientID = decoding.readVarUint(updateDecoder);
        decoding.readVarUint(updateDecoder); // clock - skip
        const stateJson = decoding.readVarString(updateDecoder);

        // Track this client ID for this connection
        if (stateJson.length > 0) {
          // Client has state - track it
          connInfo.awarenessClientIds.add(clientID);
        } else {
          // Client removed their state
          connInfo.awarenessClientIds.delete(clientID);
        }
      }
    }

    // Apply the update - this triggers the awareness 'update' event which broadcasts to all clients
    awarenessProtocol.applyAwarenessUpdate(room.awareness, update, connection);
  }

  // --------------------------------------------------------------------------
  // Sending Messages
  // --------------------------------------------------------------------------

  private sendSyncStep1(connection: Connection, doc: Y.Doc): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    connection.send(encoding.toUint8Array(encoder));
  }

  private sendAwarenessState(connection: Connection, awareness: awarenessProtocol.Awareness): void {
    const states = Array.from(awareness.getStates().keys());
    if (states.length === 0) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, states),
    );
    connection.send(encoding.toUint8Array(encoder));
  }

  private broadcastAck(room: Room, version: number): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_ACK);
    encoding.writeVarUint(encoder, version);
    const message = encoding.toUint8Array(encoder);

    for (const [conn] of room.connections) {
      try {
        conn.send(message);
      } catch {
        // Connection might be closed
      }
    }
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  private schedulePersist(flowId: string, room: Room): void {
    if (room.persistTimeout) {
      clearTimeout(room.persistTimeout);
    }

    room.persistTimeout = setTimeout(async () => {
      await this.persistRoom(flowId, room);
    }, this.persistDebounce);
  }

  private async persistRoom(flowId: string, room: Room): Promise<void> {
    if (!room.isDirty) return;

    try {
      const ydocData = Y.encodeStateAsUpdate(room.doc);

      await db
        .update(flow)
        .set({
          ydoc: Buffer.from(ydocData),
          updatedAt: new Date(),
        })
        .where(eq(flow.id, flowId));

      room.isDirty = false;
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

    // Load from database
    const flowRecord = await db.query.flow.findFirst({
      where: eq(flow.id, flowId),
    });

    // Create Y.Doc
    const doc = new Y.Doc();
    if (flowRecord?.ydoc) {
      Y.applyUpdate(doc, new Uint8Array(flowRecord.ydoc));
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
      connections: new Map(),
      persistTimeout: null,
      lastPersistedAt: Date.now(),
      isDirty: false,
    };

    // Set up doc update broadcasting
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);

      // Broadcast to all clients except the sender
      for (const [conn] of room!.connections) {
        if (conn !== origin) {
          try {
            conn.send(message);
          } catch {
            // Connection might be closed
          }
        }
      }
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
        const message = encoding.toUint8Array(encoder);

        // Broadcast to all clients except the sender
        for (const [conn] of room!.connections) {
          if (conn !== origin) {
            try {
              conn.send(message);
            } catch {
              // Connection might be closed
            }
          }
        }
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

  async forcePerist(flowId: string): Promise<void> {
    const room = this.rooms.get(flowId);
    if (room) {
      room.isDirty = true;
      await this.persistRoom(flowId, room);
    }
  }
}
