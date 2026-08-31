import type { WSContext } from "hono/ws";
import { YjsServer, type RoomConnection } from "./yjs-server";
import { CLOSE_ACCESS_DENIED } from "./protocol";
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
  /**
   * Frames that arrived before `join()` resolved, replayed in order once it
   * does. `onOpen` is async (it awaits the room load) while `onMessage` is
   * not, and a client sends sync-step-1 the instant the socket opens — so
   * without this queue that first message is dropped and the client sits in
   * `syncing` until something else happens to nudge it.
   */
  pending?: Uint8Array[];
  /** Set once the socket is closed, so a late `join()` does not resurrect it. */
  closed?: boolean;
};

/**
 * Frames buffered per socket before its room handle exists. Capped so a client
 * that floods during a slow room load cannot grow the queue without bound;
 * past the cap the socket is closed and resyncs on reconnect.
 */
const MAX_PENDING_FRAMES = 64;

// ============================================================================
// Hono WebSocket Handler
// ============================================================================

export function createYjsHandler() {
  return {
    onOpen: async (_event: Event, ws: WSContext<WebSocketData>) => {
      const data = ws.raw as unknown as WebSocketData;
      const { flowId, userId, canWrite } = data;

      if (!flowId || !userId || typeof canWrite !== "boolean") {
        // Fail closed: the endpoint sets all three only after authorizing, so
        // reconnecting with the same credentials cannot succeed — hence the
        // non-retryable close code.
        ws.close(CLOSE_ACCESS_DENIED, "Missing flowId, userId or access decision");
        return;
      }

      console.log(`[YJS] Client connected: flow=${flowId}, user=${userId}`);

      try {
        // One socket, one handle — held here for the life of the connection.
        // Every later message goes through it, so the room always recognises
        // the sender and its access decision.
        const connection = await yjsServer.join(
          flowId,
          {
            send: (bytes) => {
              try {
                ws.send(new Uint8Array(bytes) as unknown as ArrayBuffer);
              } catch {
                // WebSocket might be closed
              }
            },
            close: (code, reason) => ws.close(code, reason),
            // Lets the room drop a peer whose socket has fallen behind rather
            // than buffering for it without bound. Not every runtime exposes
            // this; `?? 0` there means "no limit enforced", which is the
            // pre-existing behaviour.
            bufferedAmount: () => (ws.raw as { bufferedAmount?: number })?.bufferedAmount ?? 0,
          },
          userId,
          canWrite,
        );

        // The socket may have closed while the room was loading. Detach
        // immediately rather than leaving a handle nobody will ever close.
        if (data.closed) {
          connection.close();
          return;
        }

        data.connection = connection;
        const pending = data.pending;
        data.pending = undefined;
        for (const frame of pending ?? []) connection.receive(frame);
      } catch (error) {
        console.error(`[YJS] Connection error:`, error);
        ws.close(1011, "Internal error");
      }
    },

    onMessage: (event: MessageEvent, ws: WSContext<WebSocketData>) => {
      const data = ws.raw as unknown as WebSocketData;

      const payload = event.data;
      if (!(payload instanceof ArrayBuffer)) return;
      const frame = new Uint8Array(payload);

      if (data.connection) {
        data.connection.receive(frame);
        return;
      }
      if (data.closed) return;

      // Still joining — hold the frame rather than dropping it.
      const pending = (data.pending ??= []);
      if (pending.length >= MAX_PENDING_FRAMES) {
        console.warn(
          `[YJS] Too many frames before join on flow=${data.flowId}; closing socket`,
        );
        data.pending = undefined;
        ws.close(1013, "Too many messages before join");
        return;
      }
      pending.push(frame);
    },

    onClose: (_event: CloseEvent, ws: WSContext<WebSocketData>) => {
      const data = ws.raw as unknown as WebSocketData;
      console.log(`[YJS] Client disconnected: flow=${data.flowId}, user=${data.userId}`);
      data.closed = true;
      data.pending = undefined;
      data.connection?.close();
    },

    onError: (_event: Event, ws: WSContext<WebSocketData>) => {
      const data = ws.raw as unknown as WebSocketData;
      data.closed = true;
      data.pending = undefined;
      data.connection?.close();
    },
  };
}

// ============================================================================
// Export server instance for testing/monitoring
// ============================================================================

export { yjsServer };
