import type { WSContext } from "hono/ws";
import { YjsServer } from "./yjs-server";

// ============================================================================
// Singleton YjsServer instance
// ============================================================================

const yjsServer = new YjsServer();

// ============================================================================
// Types
// ============================================================================

type WebSocketData = {
  flowId: string;
  userId: string;
  /** Set by the endpoint after authorizing the user on this flow. */
  canWrite: boolean;
  cleanup?: () => void;
};

// ============================================================================
// Hono WebSocket Handler
// ============================================================================

export function createYjsHandler() {
  return {
    onOpen: async (_event: Event, ws: WSContext<WebSocketData>) => {
      const { flowId, userId, canWrite } = ws.raw as unknown as WebSocketData;

      if (!flowId || !userId || typeof canWrite !== "boolean") {
        // Fail closed: the endpoint sets all three only after authorizing.
        ws.close(1008, "Missing flowId, userId or access decision");
        return;
      }

      console.log(`[YJS] Client connected: flow=${flowId}, user=${userId}`);

      try {
        const cleanup = await yjsServer.handleConnection(
          flowId,
          {
            send: (data) => {
              try {
                ws.send(new Uint8Array(data) as unknown as ArrayBuffer);
              } catch {
                // WebSocket might be closed
              }
            },
            close: () => ws.close(),
          },
          userId,
          canWrite,
        );

        // Store cleanup function for later
        (ws.raw as unknown as WebSocketData).cleanup = cleanup;
      } catch (error) {
        console.error(`[YJS] Connection error:`, error);
        ws.close(1011, "Internal error");
      }
    },

    onMessage: (event: MessageEvent, ws: WSContext<WebSocketData>) => {
      const { flowId } = ws.raw as unknown as WebSocketData;
      if (!flowId) return;

      const data = event.data;
      if (data instanceof ArrayBuffer) {
        yjsServer.handleMessage(
          flowId,
          {
            send: (d) => {
              try {
                ws.send(new Uint8Array(d) as unknown as ArrayBuffer);
              } catch {
                // WebSocket might be closed
              }
            },
            close: () => ws.close(),
          },
          new Uint8Array(data),
        );
      }
    },

    onClose: (_event: CloseEvent, ws: WSContext<WebSocketData>) => {
      const { flowId, userId, cleanup } = ws.raw as unknown as WebSocketData;
      console.log(`[YJS] Client disconnected: flow=${flowId}, user=${userId}`);
      cleanup?.();
    },

    onError: (_event: Event, ws: WSContext<WebSocketData>) => {
      const { cleanup } = ws.raw as unknown as WebSocketData;
      cleanup?.();
    },
  };
}

// ============================================================================
// Export server instance for testing/monitoring
// ============================================================================

export { yjsServer };
