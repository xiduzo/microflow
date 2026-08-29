/**
 * What does a room cost the server as the group grows?
 *
 * Presence is the term that scales quadratically: every contributor's cursor
 * update is fanned out to every other contributor, so the server's work grows
 * as N × moveRate × (N−1). This drives a real `YjsServer` with in-memory
 * sockets and counts the frames and bytes it actually emits.
 *
 * Run: bun run bench (from packages/collab)
 */

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import { YjsServer, type RoomConnection } from "./yjs-server";
import { MemoryRoomStore } from "./room-store";
import { formatRow, header, section } from "./bench-report";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/**
 * Pointer events arrive at roughly this rate while somebody is actively
 * moving the mouse. Before throttling, each one became a frame.
 */
const POINTER_EVENTS_PER_SECOND = 120;
/** After throttling at 50ms, the ceiling is 20 sends per second. */
const THROTTLED_SENDS_PER_SECOND = 20;

type Client = {
  id: string;
  connection: RoomConnection;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  /** Frames this client received from the server. */
  framesIn: number;
  bytesIn: number;
};

async function buildRoom(flowId: string, size: number) {
  const store = new MemoryRoomStore();
  // Short debounce and a rate limit well above anything we generate: this
  // measures fan-out, not the limiter, and a long debounce leaves timers
  // holding the process open after the run.
  const server = new YjsServer({ store, persistDebounce: 5, messageRateLimit: 1_000_000 });
  const clients: Client[] = [];

  for (let i = 0; i < size; i++) {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const client: Client = {
      id: `user-${i}`,
      doc,
      awareness,
      framesIn: 0,
      bytesIn: 0,
      connection: null as unknown as RoomConnection,
    };
    client.connection = await server.join(
      flowId,
      {
        send: (bytes) => {
          client.framesIn++;
          client.bytesIn += bytes.byteLength;
        },
        close: () => {},
        bufferedAmount: () => 0,
      },
      client.id,
      true,
    );
    awareness.setLocalStateField("user", {
      id: client.id,
      name: `Contributor ${i}`,
      color: "#1d4ed8",
      icon: "Cat",
      isSupporter: false,
      clientId: doc.clientID,
    });
    clients.push(client);
  }

  return { clients };
}

/** One client's cursor announcement, as the wire carries it. */
function cursorFrame(client: Client, x: number, y: number): Uint8Array {
  const state = client.awareness.getLocalState()!;
  client.awareness.setLocalStateField("user", {
    ...(state.user as Record<string, unknown>),
    cursor: { x, y },
  });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(client.awareness, [client.doc.clientID]),
  );
  return encoding.toUint8Array(encoder);
}

/** Simulate `seconds` of everyone moving their cursor at `sendsPerSecond`. */
async function measurePresence(size: number, sendsPerSecond: number, seconds: number) {
  const { clients } = await buildRoom(`presence-${size}-${sendsPerSecond}`, size);

  // Ignore the join handshake in the totals.
  for (const client of clients) {
    client.framesIn = 0;
    client.bytesIn = 0;
  }

  const sendsPerClient = sendsPerSecond * seconds;
  const start = performance.now();
  for (let tick = 0; tick < sendsPerClient; tick++) {
    for (const client of clients) {
      client.connection.receive(cursorFrame(client, tick, tick * 2));
    }
  }
  const ms = performance.now() - start;

  const framesOut = clients.reduce((sum, c) => sum + c.framesIn, 0);
  const bytesOut = clients.reduce((sum, c) => sum + c.bytesIn, 0);

  for (const client of clients) client.connection.close();

  return {
    ms,
    framesIn: size * sendsPerClient,
    framesOut,
    bytesOut,
  };
}

header("YjsServer — room load");

section("Presence fan-out over 10 seconds of everyone moving their cursor");
console.log(
  `Before: one frame per pointer event (~${POINTER_EVENTS_PER_SECOND}/s).\n` +
    `After:  coalesced to ${THROTTLED_SENDS_PER_SECOND}/s by the client throttle.\n`,
);
console.log(
  formatRow(
    ["room size", "frames out (before)", "frames out (after)", "server ms (before)", "after"],
    [11, 21, 20, 20, 10],
  ),
);

for (const size of [2, 5, 10, 20]) {
  // A tenth of the wall clock, scaled up — the full run at 120/s for 20
  // clients is ~2.9M broadcasts and takes minutes.
  const seconds = 1;
  const before = await measurePresence(size, POINTER_EVENTS_PER_SECOND, seconds);
  const after = await measurePresence(size, THROTTLED_SENDS_PER_SECOND, seconds);

  console.log(
    formatRow(
      [
        `${size}`,
        (before.framesOut * 10).toLocaleString(),
        (after.framesOut * 10).toLocaleString(),
        `${(before.ms * 10).toFixed(0)}ms`,
        `${(after.ms * 10).toFixed(0)}ms`,
      ],
      [11, 21, 20, 20, 10],
    ),
  );
}

section("Bandwidth over the same 10 seconds");
console.log(formatRow(["room size", "before", "after", "saved"], [11, 16, 16, 16]));

for (const size of [2, 5, 10, 20]) {
  const before = await measurePresence(size, POINTER_EVENTS_PER_SECOND, 1);
  const after = await measurePresence(size, THROTTLED_SENDS_PER_SECOND, 1);
  const beforeMb = (before.bytesOut * 10) / 1024 / 1024;
  const afterMb = (after.bytesOut * 10) / 1024 / 1024;

  console.log(
    formatRow(
      [
        `${size}`,
        `${beforeMb.toFixed(2)} MB`,
        `${afterMb.toFixed(2)} MB`,
        `${(100 - (afterMb / beforeMb) * 100).toFixed(0)}%`,
      ],
      [11, 16, 16, 16],
    ),
  );
}

section("Document edits — 500 node moves fanned out");
console.log(formatRow(["room size", "frames out", "server ms"], [11, 16, 16]));

for (const size of [2, 5, 10, 20]) {
  const { clients } = await buildRoom(`edits-${size}`, size);
  for (const client of clients) {
    client.framesIn = 0;
    client.bytesIn = 0;
  }

  const start = performance.now();
  for (let i = 0; i < 500; i++) {
    const author = clients[i % size]!;
    const scratch = new Y.Doc();
    scratch.getMap("nodes").set(`n${i}`, { id: `n${i}`, position: { x: i, y: i } });
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(scratch));
    author.connection.receive(encoding.toUint8Array(encoder));
  }
  const ms = performance.now() - start;
  const framesOut = clients.reduce((sum, c) => sum + c.framesIn, 0);

  console.log(
    formatRow([`${size}`, framesOut.toLocaleString(), `${ms.toFixed(0)}ms`], [11, 16, 16]),
  );
  for (const client of clients) client.connection.close();
}

// Rooms hold persist timers; nothing below this point needs the event loop.
process.exit(0);
