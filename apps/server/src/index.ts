import { trpcServer } from "@hono/trpc-server";
import { createContext } from "@microflow/api/context";
import { appRouter } from "@microflow/api/routers/index";
import { auth } from "@microflow/auth";
import { env } from "@microflow/env/server";
import { createYjsHandler } from "@microflow/collab/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";

const { upgradeWebSocket, websocket } = createBunWebSocket();

const app = new Hono();

app.use(logger());
const allowedOrigins = [
  ...env.CORS_ORIGINS,
  "tauri://localhost",
  "https://tauri.localhost",
  ...(env.NODE_ENV === "development" ? ["http://localhost:3001"] : []),
];

app.use(
  "/*",
  cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["set-auth-token"],
    credentials: true,
  }),
);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (_opts, context) => {
      return createContext({ context });
    },
  }),
);

// Yjs WebSocket endpoint for real-time collaboration
app.get(
  "/yjs/:flowId",
  upgradeWebSocket((c) => {
    const flowId = c.req.param("flowId")!;

    const handler = createYjsHandler();

    return {
      onOpen: async (event: Event, ws: WSContext) => {
        // Get session from cookie/header for auth
        const session = await auth.api.getSession({
          headers: c.req.raw.headers,
        });

        if (!session) {
          ws.close(1008, "Unauthorized");
          return;
        }

        // Attach flowId and userId to the websocket
        (ws.raw as unknown as { flowId: string; userId: string }).flowId = flowId;
        (ws.raw as unknown as { flowId: string; userId: string }).userId = session.user.id;

        handler.onOpen(event, ws as any);
      },
      onMessage: (event: MessageEvent, ws: WSContext) => {
        handler.onMessage(event, ws as any);
      },
      onClose: (event: CloseEvent, ws: WSContext) => {
        handler.onClose(event, ws as any);
      },
      onError: (event: Event, ws: WSContext) => {
        handler.onError(event, ws as any);
      },
    };
  }),
);

app.get("/", (c) => {
  return c.text("OK");
});

export default {
  fetch: app.fetch,
  websocket,
};
