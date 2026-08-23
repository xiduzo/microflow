import type { WSContext } from "hono/ws";
import { YjsServer, type RoomConnection } from "./yjs-server";
import { drizzleRoomStore } from "./drizzle-room-store";

// ============================================================================
// Singleton YjsServer instance
// ============================================================================

const yjsServer = new YjsServer({ store: drizzleRoomStore });

// ============================================================================
// Types
// ============================================================================

type WebSocketData = {
  flowId: string;
  userId: string;
  /** Set by the endpoint after authorizing the user on this flow. */
  canWrite: boolean;
  /** The room handle, held for the life of the socket. */
  connection?: RoomConnection;
};

// ============================================================================
// Hono WebSocket Handler
// ============================================================================

export function createYjsHandler() {
  return {
    onOpen: async (_event: Event, ws: WSContext<WebSocketData>) => {
      const data = ws.raw as unknown as WebSocketData;
      const { flowId, userId, canWrite } = data;

      if (!flowId || !userId || typeof canWrite !== "boolean") {
        // Fail closed: the endpoint sets all three only after authorizing.
        ws.close(1008, "Missing flowId, userId or access decision");
        return;
      }

      console.log(`[YJS] Client connected: flow=${flowId}, user=${userId}`);

      try {
        // One socket, one handle — held here for the life of the connection.
        // Every later message goes through it, so the room always recognises
        // the sender and its access decision.
        data.connection = await yjsServer.join(
          flowId,
          {
            send: (bytes) => {
              try {
                ws.send(new Uint8Array(bytes) as unknown as ArrayBuffer);
              } catch {
                // WebSocket might be closed
              }
            },
            close: () => ws.close(),
          },
          userId,
          canWrite,
        );
      } catch (error) {
        console.error(`[YJS] Connection error:`, error);
        ws.close(1011, "Internal error");
      }
    },

    onMessage: (event: MessageEvent, ws: WSContext<WebSocketData>) => {
      const { connection } = ws.raw as unknown as WebSocketData;
      if (!connection) return;

      const data = event.data;
      if (data instanceof ArrayBuffer) {
        connection.receive(new Uint8Array(data));
      }
    },

    onClose: (_event: CloseEvent, ws: WSContext<WebSocketData>) => {
      const { flowId, userId, connection } = ws.raw as unknown as WebSocketData;
      console.log(`[YJS] Client disconnected: flow=${flowId}, user=${userId}`);
      connection?.close();
    },

    onError: (_event: Event, ws: WSContext<WebSocketData>) => {
      const { connection } = ws.raw as unknown as WebSocketData;
      connection?.close();
    },
  };
}

// ============================================================================
// Export server instance for testing/monitoring
// ============================================================================

export { yjsServer };
