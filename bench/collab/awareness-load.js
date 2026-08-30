/**
 * k6: collab presence (cursor) load against the real `YjsServer` room.
 *
 * WHAT THIS MEASURES
 * Every awareness message a client sends costs the server a decode, a
 * `JSON.parse`/`JSON.stringify` round trip in `stampAwarenessIdentity`, an
 * `applyAwarenessUpdate`, and then a fan-out write to every *other* socket in
 * the room. So server work per room scales as
 *
 *     messages/sec/client × N × (N − 1)
 *
 * which makes the client's send rate the lever with the most leverage on it.
 * Before this branch the canvas called `updateCursor` straight from `onMouseMove`
 * — one encode + socket write per mouse event, which a normal mouse delivers at
 * 100–125 Hz. It is now coalesced onto `requestAnimationFrame`, so it tops out at
 * the display refresh rate, ~60 Hz.
 *
 * Run one stage per rate and compare:
 *   k6 run -e RATE_HZ=125 -e VUS=8 bench/collab/awareness-load.js
 *   k6 run -e RATE_HZ=60  -e VUS=8 bench/collab/awareness-load.js
 *
 * The headline metric is `presence_propagation_ms`: how long after a peer moves
 * their cursor this client sees it. That is the number a user actually feels.
 *
 * WHAT THIS DOES NOT MEASURE
 * Nothing in the Rust flow engine, the wasm boundary, or canvas rendering — none
 * of those cross a network. See bench/collab/README.md.
 */

import ws from "k6/ws";
import http from "k6/http";
import { check } from "k6";
import { Trend, Counter } from "k6/metrics";

const BASE = __ENV.BASE || "localhost:7777";
const FLOW_ID = __ENV.FLOW_ID || "bench-flow";
const VUS = Number(__ENV.VUS || 8);
const RATE_HZ = Number(__ENV.RATE_HZ || 60);
const DURATION_S = Number(__ENV.DURATION_S || 20);

/** Delay between this client's cursor broadcasts, in ms. */
const SEND_INTERVAL_MS = Math.max(1, Math.round(1000 / RATE_HZ));

const propagation = new Trend("presence_propagation_ms", true);
const cursorsSent = new Counter("presence_cursors_sent");
const cursorsSeen = new Counter("presence_cursors_seen");

export const options = {
  scenarios: {
    collaborators: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: 1,
      maxDuration: `${DURATION_S + 20}s`,
    },
  },
  // A cursor that lands more than a frame or two late reads as lag on the canvas.
  thresholds: {
    "presence_propagation_ms": ["p(95)<100"],
    "ws_connecting": ["p(95)<1000"],
  },
};

// ---------------------------------------------------------------------------
// lib0 wire format — the subset y-protocols' awareness messages use.
// A message is: varUint(messageType) varUint8Array(payload), and an awareness
// payload is: varUint(count) then per client varUint(clientId) varUint(clock)
// varString(JSON state).
// ---------------------------------------------------------------------------

const MESSAGE_AWARENESS = 1;

function writeVarUint(bytes, value) {
  let n = value;
  while (n > 127) {
    bytes.push(128 | (n & 127));
    n = Math.floor(n / 128);
  }
  bytes.push(n & 127);
}

function writeVarString(bytes, text) {
  const encoded = [];
  for (const byte of stringToUtf8(text)) encoded.push(byte);
  writeVarUint(bytes, encoded.length);
  for (const byte of encoded) bytes.push(byte);
}

function stringToUtf8(text) {
  // k6's runtime has no TextEncoder; the payload is ASCII JSON, but encode
  // properly anyway so an unexpected character cannot silently corrupt a frame.
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return out;
}

function createReader(bytes) {
  let position = 0;
  return {
    varUint() {
      let result = 0;
      let multiplier = 1;
      for (;;) {
        const byte = bytes[position++];
        result += (byte & 127) * multiplier;
        if ((byte & 128) === 0) return result;
        multiplier *= 128;
      }
    },
    varString() {
      const length = this.varUint();
      let text = "";
      // ASCII fast path: the states this benchmark reads back are its own JSON.
      for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[position + i]);
      position += length;
      return text;
    },
    get offset() {
      return position;
    },
    slice(length) {
      const out = bytes.slice(position, position + length);
      position += length;
      return out;
    },
    get remaining() {
      return bytes.length - position;
    },
  };
}

/** One awareness update carrying this VU's cursor, as the browser client sends it. */
function encodeCursorMessage(clientId, clock, cursor, sentAt) {
  const state = JSON.stringify({
    user: {
      id: `bench-${clientId}`,
      name: `Bench ${clientId}`,
      color: "#ff8800",
      clientId,
      cursor,
      // Stamped so the receiving VU can price the propagation delay.
      t: sentAt,
    },
  });

  const payload = [];
  writeVarUint(payload, 1);
  writeVarUint(payload, clientId);
  writeVarUint(payload, clock);
  writeVarString(payload, state);

  const message = [];
  writeVarUint(message, MESSAGE_AWARENESS);
  writeVarUint(message, payload.length);
  for (const byte of payload) message.push(byte);
  return new Uint8Array(message).buffer;
}

/** Pull every `user.t` stamp out of an inbound awareness broadcast. */
function readCursorTimestamps(buffer) {
  const bytes = new Uint8Array(buffer);
  const reader = createReader(bytes);

  if (reader.varUint() !== MESSAGE_AWARENESS) return [];
  const payloadLength = reader.varUint();
  const payload = createReader(reader.slice(payloadLength));

  const stamps = [];
  const count = payload.varUint();
  for (let i = 0; i < count; i++) {
    payload.varUint(); // clientId
    payload.varUint(); // clock
    const stateJson = payload.varString();
    try {
      const stamp = JSON.parse(stateJson);
      if (stamp && stamp.user && typeof stamp.user.t === "number") stamps.push(stamp.user.t);
    } catch {
      // A state we did not author (or a `null` removal) — not our concern.
    }
  }
  return stamps;
}

// ---------------------------------------------------------------------------
// The virtual collaborator
// ---------------------------------------------------------------------------

export default function collaborator() {
  const clientId = 1000 + __VU;
  const url = `ws://${BASE}/yjs/${FLOW_ID}`;

  const response = ws.connect(url, {}, (socket) => {
    let clock = 0;

    socket.on("open", () => {
      // Stagger VUs across the send window so they do not all fire on the same
      // tick — a real room's mice are not phase-locked, and a synchronised
      // thundering herd would flatter or punish the server for the wrong reason.
      socket.setTimeout(() => {
        socket.setInterval(() => {
          const now = Date.now();
          socket.sendBinary(
            encodeCursorMessage(
              clientId,
              clock++,
              { x: (now % 1200) - 600, y: ((now * 7) % 800) - 400 },
              now,
            ),
          );
          cursorsSent.add(1);
        }, SEND_INTERVAL_MS);
      }, (SEND_INTERVAL_MS / VUS) * __VU);
    });

    socket.on("binaryMessage", (message) => {
      const now = Date.now();
      for (const sentAt of readCursorTimestamps(message)) {
        // Skip the echo of our own cursor; the room excludes the origin, but the
        // join handshake replays the whole room state including us.
        if (sentAt > now) continue;
        propagation.add(now - sentAt);
        cursorsSeen.add(1);
      }
    });

    socket.setTimeout(() => socket.close(), DURATION_S * 1000);
  });

  check(response, { "websocket upgraded (101)": (r) => r && r.status === 101 });
}

/** Print the server-side counters next to k6's client-side view. */
export function teardown() {
  const stats = http.get(`http://${BASE}/stats`).json();
  const seconds = stats.elapsedMs / 1000;
  console.log(
    [
      "",
      "── server-side (harness /stats) ─────────────────────────────",
      `  peak connections in room : ${stats.peakConnections}`,
      `  messages received        : ${stats.messagesReceived} (${(stats.messagesReceived / seconds).toFixed(0)}/s)`,
      `  socket writes (fan-out)  : ${stats.messagesSent} (${(stats.messagesSent / seconds).toFixed(0)}/s)`,
      `  bytes written            : ${(stats.bytesSent / 1024 / 1024).toFixed(2)} MiB`,
      `  server CPU burned        : ${stats.cpuTotalMs.toFixed(0)} ms over ${seconds.toFixed(1)}s wall`,
      `  CPU per collaborator-min : ${((stats.cpuTotalMs / seconds / Math.max(1, stats.peakConnections)) * 60).toFixed(0)} ms`,
      "─────────────────────────────────────────────────────────────",
    ].join("\n"),
  );
}

export function setup() {
  http.post(`http://${BASE}/stats`);
  return {};
}
