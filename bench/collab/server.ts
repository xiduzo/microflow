/**
 * Load-test harness for the collab WebSocket room.
 *
 * Mounts the **real** `YjsServer` — the same class `apps/server` serves at
 * `/yjs/:flowId` — over Bun's WebSocket, so a k6 run exercises the production
 * message path: awareness decode, `stampAwarenessIdentity`'s re-encode, and the
 * room fan-out to every other connection.
 *
 * Two things are deliberately stubbed, and neither is on the path under test:
 *
 * - **Auth.** `apps/server` resolves a better-auth session and a per-flow role
 *   before `join`; here every socket joins as a distinct writer. Auth runs once
 *   per connection, not per message, so it is noise in a message-rate benchmark
 *   (and it would require Postgres).
 * - **Persistence.** `MemoryRoomStore` (the adapter the package already ships
 *   for tests) replaces `drizzleRoomStore`. Persistence is debounced and driven
 *   by *document* updates; this benchmark drives *awareness*, which never
 *   touches the store.
 *
 * Run: `bun bench/collab/server.ts` (PORT env, default 7777).
 * `GET /stats` returns the server-side counters and CPU time; `POST /stats/reset`
 * zeroes them so a k6 stage can be measured in isolation.
 */

import { YjsServer } from "../../packages/collab/src/yjs-server";
import { MemoryRoomStore } from "../../packages/collab/src/room-store";
import type { RoomConnection } from "../../packages/collab/src/yjs-server";

const PORT = Number(process.env.PORT ?? 7777);

const yjsServer = new YjsServer({ store: new MemoryRoomStore() });

/** Server-side counters. `sent` counts individual socket writes, so it captures
 *  the fan-out — the term that grows with the square of the room size. */
type Counters = {
  connections: number;
  peakConnections: number;
  messagesReceived: number;
  bytesReceived: number;
  messagesSent: number;
  bytesSent: number;
  startedAt: number;
  cpuAtStart: { user: number; system: number };
};

const zeroed = (): Counters => ({
  connections: 0,
  peakConnections: 0,
  messagesReceived: 0,
  bytesReceived: 0,
  messagesSent: 0,
  bytesSent: 0,
  startedAt: Date.now(),
  cpuAtStart: process.cpuUsage(),
});

let counters = zeroed();
let liveConnections = 0;
let nextUserId = 0;

type SocketData = {
  connection?: RoomConnection;
  flowId: string;
  userId: string;
};

const server = Bun.serve<SocketData, Record<string, never>>({
  port: PORT,
  idleTimeout: 60,

  fetch(request, bunServer) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/yjs/")) {
      const flowId = url.pathname.slice("/yjs/".length);
      if (!flowId) return new Response("missing flowId", { status: 400 });
      const upgraded = bunServer.upgrade(request, {
        data: { flowId, userId: `bench-user-${nextUserId++}` },
      });
      return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname === "/stats" && request.method === "POST") {
      counters = zeroed();
      counters.connections = liveConnections;
      counters.peakConnections = liveConnections;
      return Response.json({ ok: true });
    }

    if (url.pathname === "/stats") {
      const cpu = process.cpuUsage(counters.cpuAtStart);
      const elapsedMs = Date.now() - counters.startedAt;
      return Response.json({
        ...counters,
        elapsedMs,
        // Microseconds → milliseconds of CPU actually burned in this window.
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        cpuTotalMs: (cpu.user + cpu.system) / 1000,
      });
    }

    if (url.pathname === "/health") return new Response("OK");
    return new Response("not found", { status: 404 });
  },

  websocket: {
    async open(ws) {
      liveConnections += 1;
      counters.connections = liveConnections;
      counters.peakConnections = Math.max(counters.peakConnections, liveConnections);

      ws.data.connection = await yjsServer.join(
        ws.data.flowId,
        {
          send: (bytes: Uint8Array) => {
            counters.messagesSent += 1;
            counters.bytesSent += bytes.byteLength;
            try {
              ws.send(bytes);
            } catch {
              // socket closed mid-broadcast; the room drops it on close
            }
          },
          close: () => ws.close(),
        },
        ws.data.userId,
        true,
      );
    },

    message(ws, message) {
      const bytes =
        typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message);
      counters.messagesReceived += 1;
      counters.bytesReceived += bytes.byteLength;
      ws.data.connection?.receive(bytes);
    },

    close(ws) {
      liveConnections -= 1;
      counters.connections = liveConnections;
      ws.data.connection?.close();
    },
  },
});

console.log(`[bench] collab harness on http://localhost:${server.port}`);
console.log(`[bench] websocket: ws://localhost:${server.port}/yjs/<flowId>`);
