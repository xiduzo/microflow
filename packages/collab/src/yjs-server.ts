import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { db } from "@microflow/db";
import { flow } from "@microflow/db/schema/flow";
import { eq } from "drizzle-orm";
import { createEmptyFlowDoc, encodeYDoc, decodeYDoc } from "./utils";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export type YjsServerOptions = {
  /** Debounce time for persisting to database (ms) */
  persistDebounce?: number;
};

type Connection = {
  send: (data: Uint8Array) => void;
  close: () => void;
};

type Room = {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  connections: Map<Connection, { clientId: number }>;
  persistTimeout: ReturnType<typeof setTimeout> | null;
};

export class YjsServer {
  private rooms = new Map<string, Room>();
  private persistDebounce: number;

  constructor(options: YjsServerOptions = {}) {
    this.persistDebounce = options.persistDebounce ?? 2000;
  }

  /**
   * Handle a new WebSocket connection for a flow
   */
  async handleConnection(
    flowId: string,
    connection: Connection,
    userId: string
  ): Promise<() => void> {
    const room = await this.getOrCreateRoom(flowId);
    const clientId = room.doc.clientID;

    room.connections.set(connection, { clientId });
    console.log(`[YJS-SERVER] Room ${flowId} now has ${room.connections.size} connection(s)`);

    // Send initial sync
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    connection.send(encoding.toUint8Array(encoder));

    // Send awareness state
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(
        room.awareness,
        Array.from(room.awareness.getStates().keys())
      )
    );
    connection.send(encoding.toUint8Array(awarenessEncoder));

    // Return cleanup function
    return () => {
      room.connections.delete(connection);
      console.log(`[YJS-SERVER] Room ${flowId} now has ${room.connections.size} connection(s) after disconnect`);
      awarenessProtocol.removeAwarenessStates(room.awareness, [clientId], null);

      // Clean up room if no connections
      if (room.connections.size === 0) {
        this.persistRoom(flowId, room);
        this.rooms.delete(flowId);
      }
    };
  }

  /**
   * Handle incoming message from a connection
   */
  handleMessage(
    flowId: string,
    connection: Connection,
    data: Uint8Array
  ): void {
    const room = this.rooms.get(flowId);
    if (!room) return;

    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC:
        this.handleSyncMessage(room, connection, decoder);
        break;
      case MESSAGE_AWARENESS:
        this.handleAwarenessMessage(room, decoder);
        break;
    }
  }

  private handleSyncMessage(
    room: Room,
    connection: Connection,
    decoder: decoding.Decoder
  ): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    const syncMessageType = syncProtocol.readSyncMessage(
      decoder,
      encoder,
      room.doc,
      connection // Use connection as origin to track source
    );

    // Send response back to the sender if needed (sync step 2)
    if (encoding.length(encoder) > 1) {
      connection.send(encoding.toUint8Array(encoder));
    }

    // If we received an update, schedule persist (broadcasting is handled by doc observer)
    if (syncMessageType === syncProtocol.messageYjsUpdate) {
      this.schedulePersist(room);
    }
  }

  private handleAwarenessMessage(room: Room, decoder: decoding.Decoder): void {
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(room.awareness, update, null);
    
    // Broadcast awareness to all other clients
    this.broadcastAwareness(room, update);
  }

  private broadcastAwareness(room: Room, update: Uint8Array, excludeConnection?: Connection): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    const message = encoding.toUint8Array(encoder);

    for (const [conn] of room.connections) {
      if (conn !== excludeConnection) {
        conn.send(message);
      }
    }
  }

  private schedulePersist(room: Room): void {
    if (room.persistTimeout) {
      clearTimeout(room.persistTimeout);
    }
    room.persistTimeout = setTimeout(() => {
      const flowId = this.findFlowIdByRoom(room);
      if (flowId) {
        this.persistRoom(flowId, room);
      }
    }, this.persistDebounce);
  }

  private findFlowIdByRoom(room: Room): string | undefined {
    for (const [flowId, r] of this.rooms) {
      if (r === room) return flowId;
    }
    return undefined;
  }

  private async persistRoom(flowId: string, room: Room): Promise<void> {
    const ydocData = encodeYDoc(room.doc);
    await db
      .update(flow)
      .set({ ydoc: Buffer.from(ydocData) })
      .where(eq(flow.id, flowId));
  }

  private async getOrCreateRoom(flowId: string): Promise<Room> {
    let room = this.rooms.get(flowId);
    if (room) return room;

    // Load from database or create new
    const flowRecord = await db.query.flow.findFirst({
      where: eq(flow.id, flowId),
    });

    let doc: Y.Doc;
    if (flowRecord?.ydoc) {
      doc = decodeYDoc(new Uint8Array(flowRecord.ydoc));
    } else {
      doc = createEmptyFlowDoc();
    }

    const awareness = new awarenessProtocol.Awareness(doc);

    room = {
      doc,
      awareness,
      connections: new Map(),
      persistTimeout: null,
    };

    // Broadcast doc updates to all clients except the sender
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);

      for (const [conn] of room!.connections) {
        // Don't send back to the connection that sent the update
        if (conn !== origin) {
          conn.send(message);
        }
      }
    });

    // Broadcast awareness changes
    awareness.on(
      "update",
      ({
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => {
        const changedClients = added.concat(updated, removed);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
        );
        const message = encoding.toUint8Array(encoder);

        for (const [conn] of room!.connections) {
          conn.send(message);
        }
      }
    );

    this.rooms.set(flowId, room);
    return room;
  }
}
