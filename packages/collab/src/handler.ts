import type { Context } from "hono";
import type { WSContext } from "hono/ws";
import { YjsServer } from "./yjs-server";

const yjsServer = new YjsServer();

type WebSocketData = {
  flowId: string;
  userId: string;
  cleanup?: () => void;
};

/**
 * Create Hono WebSocket handlers for Yjs collaboration
 */
export function createYjsHandler() {
  return {
    onOpen: async (
      _event: Event,
      ws: WSContext<WebSocketData>
    ) => {
      const { flowId, userId } = ws.raw as unknown as WebSocketData;
      if (!flowId || !userId) {
        ws.close(1008, "Missing flowId or userId");
        return;
      }

      const cleanup = await yjsServer.handleConnection(
        flowId,
        {
          send: (data) => ws.send(data),
          close: () => ws.close(),
        },
        userId
      );

      // Store cleanup function
      (ws.raw as unknown as WebSocketData).cleanup = cleanup;
    },

    onMessage: (
      event: MessageEvent,
      ws: WSContext<WebSocketData>
    ) => {
      const { flowId } = ws.raw as unknown as WebSocketData;
      if (!flowId) return;

      const data = event.data;
      if (data instanceof ArrayBuffer) {
        yjsServer.handleMessage(flowId, {
          send: (d) => ws.send(d),
          close: () => ws.close(),
        }, new Uint8Array(data));
      }
    },

    onClose: (
      _event: CloseEvent,
      ws: WSContext<WebSocketData>
    ) => {
      const { cleanup } = ws.raw as unknown as WebSocketData;
      cleanup?.();
    },

    onError: (
      _event: Event,
      ws: WSContext<WebSocketData>
    ) => {
      const { cleanup } = ws.raw as unknown as WebSocketData;
      cleanup?.();
    },
  };
}
