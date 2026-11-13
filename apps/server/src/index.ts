import { trpcServer } from "@hono/trpc-server";
import { createContext } from "@microflow/api/context";
import { appRouter } from "@microflow/api/routers/index";
import { getPublicSupportersCached } from "@microflow/api/routers/supporters";
import { FlowAccessDenied, requireFlowAccess } from "@microflow/api/routers/flow-access";
import { auth } from "@microflow/auth";
import { env } from "@microflow/env/server";
import { createYjsHandler, yjsServer } from "@microflow/collab/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { redactSecrets } from "./log-redaction";
import { decideRoomAccess } from "./room-gate";
import { installShutdownHook, type Drain } from "./shutdown";

const { upgradeWebSocket, websocket } = createBunWebSocket();

const app = new Hono();

// The logger prints the full URL; the desktop app's `/yjs` upgrade carries its
// bearer token in the query string.
app.use(logger((line, ...rest) => console.log(redactSecrets(line), ...rest)));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  // The stack stays in the server log. Clients get no internals: file paths,
  // dependency versions and query shapes are reconnaissance, not diagnostics.
  console.error(`[error] ${c.req.method} ${c.req.path}`, err);
  return c.json({ error: "Internal Server Error" }, 500);
});

// Save live collaboration rooms before a deploy or Ctrl-C ends the process.
// 8 s sits inside Docker's default 10 s stop grace period.
//
// Under `bun --hot` this module re-evaluates on every edit: the listeners are
// installed once per process and always drain the latest room server.
const SHUTDOWN_DRAIN = Symbol.for("microflow.server.shutdownDrain");
const hookHost = globalThis as { [SHUTDOWN_DRAIN]?: Drain };
const firstEvaluation = !hookHost[SHUTDOWN_DRAIN];
hookHost[SHUTDOWN_DRAIN] = (timeoutMs) => yjsServer.shutdown(timeoutMs);
if (firstEvaluation) {
  installShutdownHook((timeoutMs) => hookHost[SHUTDOWN_DRAIN]!(timeoutMs), process, {
    timeoutMs: 8_000,
    exit: (code) => process.exit(code),
  });
}
const allowedOrigins = [
  ...env.CORS_ORIGINS,
  "tauri://localhost",
  "https://tauri.localhost",
  // Tauri v2 on Windows serves the app from http://tauri.localhost by default
  // (app.windows.useHttpsScheme is false), unlike macOS/Linux (tauri://localhost)
  "http://tauri.localhost",
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

app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  const res = await auth.handler(c.req.raw);
  if (res.status >= 500) {
    const clone = res.clone();
    const body = await clone.text();
    console.error("[auth 500]", c.req.path, body);
  }
  return res;
});

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
        // Also support bearer token via query param (for Tauri where cookies aren't available)
        const token = c.req.query("token");
        const headers = new Headers(c.req.raw.headers);
        if (token && !headers.get("authorization")) {
          headers.set("authorization", `Bearer ${token}`);
        }

        const decision = await decideRoomAccess({
          getSession: () => auth.api.getSession({ headers }),
          requireAccess: (userId) => requireFlowAccess(flowId, userId, "viewer"),
          classifyDenial: (error) => (error instanceof FlowAccessDenied ? error.kind : null),
        });
        if (!decision.ok) {
          ws.close(decision.code, decision.reason);
          return;
        }

        // Attach flowId, userId and the access decision to the websocket
        const data = ws.raw as unknown as {
          flowId: string;
          userId: string;
          canWrite: boolean;
        };
        data.flowId = flowId;
        data.userId = decision.userId;
        data.canWrite = decision.canWrite;

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

app.get("/api/public/supporters", async (c) => {
  const supporters = await getPublicSupportersCached();
  return c.json({ supporters });
});

app.get("/", (c) => {
  return c.text("OK");
});

export default {
  fetch: app.fetch,
  websocket,
};
