// Test support: a scripted MQTT 3.1.1 broker on a loopback WebSocket, for
// driving the real `mqtt.js` client (`mqtt-client.real.test.ts`). It logs every
// packet a client sends, answers the way a test tells it to (refuse a topic,
// hold its SUBACKs back), delivers messages at QoS 0, and can cut every link.
//
// It is as strict as a real broker where a client could get away with less:
//
// - It routes by its own reading of the topic filters, not the client's.
// - It keeps the retained message of each topic, set by a client's PUBLISH
//   with RETAIN (an empty one clears it) or by `retain()`, and answers every
//   accepted SUBSCRIBE with the retained messages its filter matches, flagged.
//   A message it forwards to a subscription that already exists is unflagged.
// - It closes the connection of a client that publishes on a topic with a
//   wildcard, or on an empty one (MQTT 3.1.1 §3.3.2.1, §4.8).
// - After `copyPerSubscription()` it sends a message once for every filter of
//   a connection that matches it, as MQTT 3.1.1 §3.3.5 allows and mosquitto 2
//   and EMQX do. Until then, once per connection.
// - It keeps the will a CONNECT carries and publishes it, as a client's
//   PUBLISH would be (§3.1.2.5), when the connection ends without a
//   DISCONNECT: the client's socket closed, `drop()` cut it, or the broker
//   closed it over a protocol violation. A DISCONNECT discards the will.
// - A CONNECT with the client id of a connection that is open ends that
//   connection first (§3.1.4), and so publishes its will.
// - It closes the connection of a client whose will topic is not a topic name.
//
// It speaks only what those tests need: CONNECT, SUBSCRIBE, UNSUBSCRIBE,
// PUBLISH at QoS 0, PINGREQ and DISCONNECT.

/** A message the broker publishes for a client whose connection ends without
 *  a DISCONNECT. */
type Will = { topic: string; payload: string; retain: boolean };

type SocketData = {
  /** Bytes received that do not make a whole packet yet. */
  pending: Uint8Array;
  topics: Set<string>;
  /** The client id its CONNECT gave. */
  clientId: string | undefined;
  /** The will its CONNECT carried, until a DISCONNECT discards it. */
  will: Will | undefined;
};
/** What the broker uses of a Bun `ServerWebSocket`. */
type Socket = { data: SocketData; send(bytes: Uint8Array): unknown; terminate(): void };
/** What it uses of the Bun server handed to `fetch`. */
type Upgrader = { upgrade(request: Request, options: { data: SocketData }): boolean };

/** `Bun.serve`, as far as this file uses it. The app's tsconfig checks this
 *  file and does not load Bun's types (they would retype `fetch` for the whole
 *  app), so the one call is typed here. It runs under `bun test` only. */
const bunServe = (
  globalThis as unknown as {
    Bun: {
      serve(options: {
        hostname: string;
        port: number;
        fetch(request: Request, server: Upgrader): Response | undefined;
        websocket: {
          open(socket: Socket): void;
          message(socket: Socket, message: string | Uint8Array): void;
          close(socket: Socket): void;
        };
      }): { port: number; stop(closeConnections: boolean): unknown };
    };
  }
).Bun.serve;

const SUBACK_FAILURE = 0x80;

export type ScriptedBroker = ReturnType<typeof startScriptedBroker>;

export function startScriptedBroker() {
  const sockets = new Set<Socket>();
  const log: string[] = [];
  const refused = new Set<string>();
  const retained = new Map<string, string>();
  const willsPublished: string[] = [];
  let holding = false;
  let perSubscription = false;
  let stopping = false;
  const heldBack: Array<() => void> = [];

  function answer(send: () => void): void {
    if (holding) heldBack.push(send);
    else send();
  }

  /** Send a message on `topic` to every connection that subscribed to it. */
  function route(topic: string, payload: string): void {
    const packet = publishPacket(topic, payload, false);
    for (const socket of sockets) {
      const matching = [...socket.data.topics].filter((filter) => brokerMatches(filter, topic)).length;
      const copies = perSubscription ? matching : Math.min(matching, 1);
      for (let copy = 0; copy < copies; copy++) socket.send(packet);
    }
  }

  /** Take a message as a PUBLISH from a client: keep it when it is retained,
   *  and send it on. */
  function accept(topic: string, payload: string, retain: boolean): void {
    if (retain && payload.length === 0) retained.delete(topic);
    else if (retain) retained.set(topic, payload);
    route(topic, payload);
  }

  function onConnect(socket: Socket, body: DataView): void {
    const [, levelAt] = readText(body, 0);
    const flags = body.getUint8(levelAt + 1);
    const [clientId, next] = readText(body, levelAt + 4);
    let will: Will | undefined;
    if ((flags & 0x04) !== 0) {
      const [topic, payloadAt] = readText(body, next);
      const end = payloadAt + 2 + body.getUint16(payloadAt);
      const payload = new TextDecoder().decode(bytesFrom(body, payloadAt + 2, end));
      will = { topic, payload, retain: (flags & 0x20) !== 0 };
    }
    log.push(`CONNECT${will ? ` will ${describe(will.topic, will.payload, will.retain)}` : ""}`);
    if (will && !isTopicName(will.topic)) {
      // A protocol violation: the broker closes the connection unanswered.
      socket.terminate();
      return;
    }
    // A client id that is connected already: that connection is ended first.
    for (const other of sockets) {
      if (other !== socket && other.data.clientId === clientId) other.terminate();
    }
    socket.data.clientId = clientId;
    socket.data.will = will;
    socket.send(Uint8Array.of(0x20, 2, 0, 0));
  }

  function onPacket(socket: Socket, type: number, flags: number, body: DataView): void {
    switch (type) {
      case 1:
        onConnect(socket, body);
        break;
      case 3: {
        const [topic, at] = readText(body, 0);
        const payload = new TextDecoder().decode(bytesFrom(body, at));
        const retain = (flags & 1) === 1;
        log.push(`PUBLISH ${describe(topic, payload, retain)}`);
        if (!isTopicName(topic)) {
          // A protocol violation: the broker closes the connection.
          socket.terminate();
          break;
        }
        accept(topic, payload, retain);
        break;
      }
      case 8: {
        const id = body.getUint16(0);
        const codes: number[] = [];
        const replays: Uint8Array[] = [];
        for (let at = 2; at < body.byteLength; ) {
          const [topic, next] = readText(body, at);
          at = next + 1; // the requested QoS follows each topic
          log.push(`SUBSCRIBE ${topic}`);
          const accepted = !refused.has(topic);
          if (accepted) {
            socket.data.topics.add(topic);
            for (const [name, payload] of retained) {
              if (brokerMatches(topic, name)) replays.push(publishPacket(name, payload, true));
            }
          }
          codes.push(accepted ? 0 : SUBACK_FAILURE);
        }
        const suback = Uint8Array.of(0x90, 2 + codes.length, id >> 8, id & 0xff, ...codes);
        answer(() => {
          socket.send(suback);
          for (const replay of replays) socket.send(replay);
        });
        break;
      }
      case 10: {
        const id = body.getUint16(0);
        for (let at = 2; at < body.byteLength; ) {
          const [topic, next] = readText(body, at);
          at = next;
          log.push(`UNSUBSCRIBE ${topic}`);
          socket.data.topics.delete(topic);
        }
        socket.send(Uint8Array.of(0xb0, 2, id >> 8, id & 0xff));
        break;
      }
      case 12:
        socket.send(Uint8Array.of(0xd0, 0));
        break;
      case 14:
        log.push("DISCONNECT");
        // The client leaves on purpose: its will is not published.
        socket.data.will = undefined;
        break;
    }
  }

  const server = bunServe({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request: Request, bun: Upgrader) {
      // Bun answers the `mqtt` subprotocol the client asks for by itself.
      const data: SocketData = {
        pending: new Uint8Array(0),
        topics: new Set(),
        clientId: undefined,
        will: undefined,
      };
      return bun.upgrade(request, { data }) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open(socket: Socket) {
        sockets.add(socket);
      },
      message(socket: Socket, message: string | Uint8Array) {
        const chunk = typeof message === "string" ? new TextEncoder().encode(message) : message;
        let bytes = concat(socket.data.pending, chunk);
        for (let packet = takePacket(bytes); packet; packet = takePacket(bytes)) {
          bytes = packet.rest;
          onPacket(socket, packet.type, packet.flags, packet.body);
        }
        socket.data.pending = bytes;
      },
      close(socket: Socket) {
        sockets.delete(socket);
        const { will } = socket.data;
        socket.data.will = undefined;
        // The connection ended without a DISCONNECT. The test is over once
        // the broker stops: nobody is left to hear a will then.
        if (!will || stopping) return;
        willsPublished.push(describe(will.topic, will.payload, will.retain));
        accept(will.topic, will.payload, will.retain);
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}/mqtt`,

    /** Every packet the clients sent, oldest first. */
    packets: (): string[] => [...log],

    /** How many of the packets sent so far start with `prefix`. */
    count: (prefix: string): number => log.filter((packet) => packet.startsWith(prefix)).length,

    /** How many clients have a socket open to the broker right now. */
    connections: (): number => sockets.size,

    /** Answer a SUBSCRIBE for `topic` with the failure code from now on. */
    refuse: (topic: string): void => void refused.add(topic),

    /** Accept every topic again. */
    acceptAll: (): void => refused.clear(),

    /** Keep the SUBACKs back until `release()`. */
    holdAnswers: (): void => {
      holding = true;
    },

    /** Send the SUBACKs kept back, and answer at once from now on. */
    release(): void {
      holding = false;
      for (const send of heldBack.splice(0)) send();
    },

    /** From now on send a message once for every filter of a connection that
     *  matches it, not once per connection. */
    copyPerSubscription: (): void => {
      perSubscription = true;
    },

    /** Make `payload` the retained message of `topic`, for the SUBSCRIBEs to
     *  come; an empty one clears it. Nothing is sent now. */
    retain(topic: string, payload: string): void {
      if (payload.length === 0) retained.delete(topic);
      else retained.set(topic, payload);
    },

    /** The retained message of `topic`: what a client that subscribes to it
     *  now is sent first. */
    retained: (topic: string): string | undefined => retained.get(topic),

    /** The wills the broker published, oldest first, as `topic payload`
     *  with ` retain` when retained. */
    wills: (): string[] => [...willsPublished],

    /** A message from another client, to every connection that subscribed to
     *  `topic`. */
    publish: (topic: string, payload: string): void => route(topic, payload),

    /** Cut every link, as a lost network or a tab that vanished does: no
     *  DISCONNECT, so every will is published. */
    drop(): void {
      for (const socket of sockets) socket.terminate();
    },

    stop(): void {
      stopping = true;
      void server.stop(true);
    },
  };
}

/** A PUBLISH as the log and the will list write it. */
function describe(topic: string, payload: string, retain: boolean): string {
  return `${topic} ${payload}${retain ? " retain" : ""}`;
}

/** A topic a message can be published on: not empty, no wildcard. */
function isTopicName(topic: string): boolean {
  return topic.length > 0 && !/[+#]/.test(topic);
}

/**
 * Whether the broker sends a message on `topic` for a subscription to
 * `filter`: the broker's own reading, written apart from the client's
 * `topicMatches` so that a mistake there is not made here too.
 */
function brokerMatches(filter: string, topic: string): boolean {
  const shared = /^\$share\/[^/+#]+\/(.+)$/.exec(filter) ?? /^\$queue\/(.+)$/.exec(filter);
  const wanted = (shared ? shared[1] : filter).split("/");
  const levels = topic.split("/");
  if (topic.startsWith("$") && /^[+#]/.test(wanted[0])) return false;
  let index = 0;
  for (; index < wanted.length; index++) {
    if (wanted[index] === "#") return index === wanted.length - 1;
    if (index === levels.length) return false;
    if (wanted[index] !== "+" && wanted[index] !== levels[index]) return false;
  }
  return index === levels.length;
}

/** A PUBLISH at QoS 0, with or without the RETAIN flag. */
function publishPacket(topic: string, payload: string, retain: boolean): Uint8Array {
  const name = new TextEncoder().encode(topic);
  const body = concat(
    Uint8Array.of(name.length >> 8, name.length & 0xff),
    name,
    new TextEncoder().encode(payload),
  );
  return concat(Uint8Array.of(0x30 | (retain ? 1 : 0)), remainingLength(body.length), body);
}

/** The variable-length encoding of a packet's remaining length. */
function remainingLength(length: number): Uint8Array {
  const out: number[] = [];
  let rest = length;
  do {
    const digit = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? digit | 0x80 : digit);
  } while (rest > 0);
  return Uint8Array.from(out);
}

/** The first whole packet in `bytes`, or `null` when more bytes are needed. */
function takePacket(
  bytes: Uint8Array,
): { type: number; flags: number; body: DataView; rest: Uint8Array } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let length = 0;
  let at = 1;
  for (let shift = 0; ; shift += 7) {
    if (at >= bytes.length) return null;
    const byte = view.getUint8(at);
    at += 1;
    length |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
  }
  if (bytes.length < at + length) return null;
  const first = view.getUint8(0);
  return {
    type: first >> 4,
    flags: first & 0x0f,
    body: new DataView(bytes.buffer, bytes.byteOffset + at, length),
    rest: bytes.subarray(at + length),
  };
}

/** A length-prefixed UTF-8 string at `at`, and the offset after it. */
function readText(view: DataView, at: number): [string, number] {
  const end = at + 2 + view.getUint16(at);
  return [new TextDecoder().decode(bytesFrom(view, at + 2, end)), end];
}

function bytesFrom(view: DataView, start: number, end = view.byteLength): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset + start, end - start);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Wait until `check` holds. Fails after `timeout` ms, so a broken test does not hang. */
export async function until(check: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("the condition did not hold in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
