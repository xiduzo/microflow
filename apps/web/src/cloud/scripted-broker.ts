// Test support: a scripted MQTT 5 broker on a loopback WebSocket, for driving
// the real `mqtt.js` client (`mqtt-client.real.test.ts`). It logs every packet
// a client sends, answers the way a test tells it to (refuse a topic, hold its
// SUBACKs back), delivers messages at QoS 0, and can cut every link.
//
// It is as strict as a real broker where a client could get away with less:
//
// - It speaks MQTT 5 only: a CONNECT of another protocol version is answered
//   "unacceptable protocol version" and the connection closed (MQTT 5
//   §3.1.2.2).
// - After `speakOnly311(refusal)` it is a broker that speaks MQTT 3.1.1 only,
//   and refuses an MQTT 5 CONNECT the way `refusal` says: with a 3.1.1
//   CONNACK "unacceptable protocol version" (return code 1), with an MQTT 5
//   CONNACK "Unsupported Protocol Version" (reason code 0x84), or by closing
//   the connection without a CONNACK. It closes the connection after a
//   CONNACK too.
// - It routes by its own reading of the topic filters, not the client's, and
//   at the moment a message is published: to the subscriptions it holds then.
//   After `answerSubscribesAfter(ms)` it is a broker under load, which takes
//   a while over each SUBSCRIBE before the subscription exists and its SUBACK
//   goes out.
// - It tags every PUBLISH it sends with the subscription identifiers of the
//   subscriptions it is for (§3.3.4): a SUBSCRIBE that carries one gives its
//   filter that id, until the filter is subscribed again or unsubscribed.
// - By default it sends one copy of a message for all of a connection's
//   matching subscriptions, carrying the id of each, as HiveMQ does. After
//   `copyPerSubscription()` it sends one copy per matching subscription, each
//   carrying that subscription's id, as mosquitto 2 and EMQX do.
// - After `withoutSubscriptionIds()` its CONNACK says it takes no subscription
//   identifiers, it tags nothing, and it closes the connection of a client
//   whose SUBSCRIBE carries one anyway (§3.8.2.1.2).
// - It keeps the retained message of each topic, set by a client's PUBLISH
//   with RETAIN (an empty one clears it) or by `retain()`, and answers every
//   accepted SUBSCRIBE with the retained messages its filter matches, flagged
//   and tagged with that subscription's id. A message it forwards to a
//   subscription that already exists is unflagged.
// - It closes the connection of a client that publishes on a topic with a
//   wildcard, or on an empty one (§3.3.2.1, §4.7).
// - It keeps the will a CONNECT carries and publishes it, as a client's
//   PUBLISH would be (§3.1.2.5), when the connection ends without a
//   DISCONNECT: the client's socket closed, `drop()` cut it, or the broker
//   closed it over a protocol violation. A DISCONNECT discards the will,
//   unless its reason code is 0x04 ("Disconnect with Will Message").
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
  /** The filters it subscribed to, each with the subscription identifier its
   *  SUBSCRIBE gave, if any. */
  topics: Map<string, number | undefined>;
  /** The client id its CONNECT gave. */
  clientId: string | undefined;
  /** The will its CONNECT carried, until a DISCONNECT discards it. */
  will: Will | undefined;
  /** Every packet its client sent, oldest first. */
  packets: string[];
};
/**
 * What the broker uses of a Bun `ServerWebSocket`.
 *
 * `close()` ends the connection with a close frame, after what was sent before
 * it; `terminate()` cuts it at once, and may drop a frame still on its way out
 * (Bun 1.3.5 drops the CONNACK of a refusal that way). A broker that answers
 * and then hangs up closes; one that drops a connection terminates.
 */
type Socket = { data: SocketData; send(bytes: Uint8Array): unknown; close(): void; terminate(): void };
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

/** How a broker that speaks only MQTT 3.1.1 refuses an MQTT 5 CONNECT. */
export type Mqtt5Refusal = "connack 3.1.1" | "connack 5" | "close";

/** What the broker sends, per {@link Mqtt5Refusal}, before it closes the
 *  connection. */
const REFUSALS: Record<Mqtt5Refusal, Uint8Array | undefined> = {
  // MQTT 3.1.1's CONNACK: session present 0, return code 1, "unacceptable
  // protocol version" (MQTT 3.1.1 §3.2.2.3).
  "connack 3.1.1": Uint8Array.of(0x20, 2, 0, 0x01),
  // MQTT 5's CONNACK: session present 0, reason code 0x84, "Unsupported
  // Protocol Version", no properties (MQTT 5 §3.2.2.2).
  "connack 5": Uint8Array.of(0x20, 3, 0, 0x84, 0),
  close: undefined,
};

export type ScriptedBroker = ReturnType<typeof startScriptedBroker>;

export function startScriptedBroker() {
  const sockets = new Set<Socket>();
  const log: string[] = [];
  /** The packet log of every connection there was, in the order they opened. */
  const everConnected: string[][] = [];
  const refused = new Set<string>();
  const retained = new Map<string, string>();
  const willsPublished: string[] = [];
  let holding = false;
  let perSubscription = false;
  let tagging = true;
  let stopping = false;
  /** How long the broker takes over a SUBSCRIBE, in ms. */
  let subscribeDelay = 0;
  /** Set while the broker speaks MQTT 3.1.1 only: how it refuses MQTT 5. */
  let only311: Mqtt5Refusal | undefined;
  const heldBack: Array<() => void> = [];

  /** Log a packet `socket`'s client sent, in the broker's log and its own. */
  function record(socket: Socket, packet: string): void {
    log.push(packet);
    socket.data.packets.push(packet);
  }

  function answer(send: () => void): void {
    if (holding) heldBack.push(send);
    else send();
  }

  /** The subscription identifiers a PUBLISH for these subscriptions carries. */
  function tags(ids: Array<number | undefined>): number[] {
    return tagging ? ids.filter((id): id is number => id !== undefined) : [];
  }

  /** Send a message on `topic` to every connection that subscribed to it. */
  function route(topic: string, payload: string): void {
    for (const socket of sockets) {
      const matching = [...socket.data.topics]
        .filter(([filter]) => brokerMatches(filter, topic))
        .map(([, id]) => id);
      if (matching.length === 0) continue;
      if (perSubscription) {
        for (const id of matching) socket.send(publishPacket(topic, payload, false, tags([id])));
      } else {
        socket.send(publishPacket(topic, payload, false, tags(matching)));
      }
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
    const level = body.getUint8(levelAt);
    if (level !== 5) {
      record(socket, `CONNECT level ${level}`);
      // MQTT 3.1.1's CONNACK: "unacceptable protocol version", then closed.
      socket.send(Uint8Array.of(0x20, 2, 0, 0x01));
      socket.close();
      return;
    }
    if (only311) {
      record(socket, `CONNECT refused: ${only311}`);
      const connack = REFUSALS[only311];
      if (connack) socket.send(connack);
      socket.close();
      return;
    }
    const flags = body.getUint8(levelAt + 1);
    const [clientId, next] = readText(body, skipProperties(body, levelAt + 4));
    let will: Will | undefined;
    if ((flags & 0x04) !== 0) {
      const [topic, payloadAt] = readText(body, skipProperties(body, next));
      const end = payloadAt + 2 + body.getUint16(payloadAt);
      const payload = new TextDecoder().decode(bytesFrom(body, payloadAt + 2, end));
      will = { topic, payload, retain: (flags & 0x20) !== 0 };
    }
    record(socket, `CONNECT${will ? ` will ${describe(will.topic, will.payload, will.retain)}` : ""}`);
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
    // Session present 0, reason "Success", and the properties: none, or
    // "Subscription Identifiers Available" 0.
    socket.send(tagging ? Uint8Array.of(0x20, 3, 0, 0, 0) : Uint8Array.of(0x20, 5, 0, 0, 2, 0x29, 0));
  }

  function onSubscribe(socket: Socket, body: DataView): void {
    const id = body.getUint16(0);
    const [subscriptionId, first] = readSubscriptionId(body, 2);
    if (subscriptionId !== undefined && !tagging) {
      // A protocol violation: this broker said it takes none.
      record(socket, "SUBSCRIBE with a subscription identifier");
      socket.terminate();
      return;
    }
    const topics: string[] = [];
    for (let at = first; at < body.byteLength; ) {
      const [topic, next] = readText(body, at);
      at = next + 1; // the subscription options follow each topic
      record(socket, `SUBSCRIBE ${topic}`);
      topics.push(topic);
    }
    const take = () => {
      // The connection ended while the broker was busy with it.
      if (!sockets.has(socket)) return;
      const codes: number[] = [];
      const replays: Uint8Array[] = [];
      for (const topic of topics) {
        const accepted = !refused.has(topic);
        if (accepted) {
          socket.data.topics.set(topic, subscriptionId);
          for (const [name, payload] of retained) {
            if (brokerMatches(topic, name)) {
              replays.push(publishPacket(name, payload, true, tags([subscriptionId])));
            }
          }
        }
        codes.push(accepted ? 0 : SUBACK_FAILURE);
      }
      // No properties, then a reason code per topic.
      const suback = Uint8Array.of(0x90, 3 + codes.length, id >> 8, id & 0xff, 0, ...codes);
      answer(() => {
        socket.send(suback);
        for (const replay of replays) socket.send(replay);
      });
    };
    if (subscribeDelay > 0) setTimeout(take, subscribeDelay);
    else take();
  }

  function onPacket(socket: Socket, type: number, flags: number, body: DataView): void {
    switch (type) {
      case 1:
        onConnect(socket, body);
        break;
      case 3: {
        const [topic, at] = readText(body, 0);
        const payload = new TextDecoder().decode(bytesFrom(body, skipProperties(body, at)));
        const retain = (flags & 1) === 1;
        record(socket, `PUBLISH ${describe(topic, payload, retain)}`);
        if (!isTopicName(topic)) {
          // A protocol violation: the broker closes the connection.
          socket.terminate();
          break;
        }
        accept(topic, payload, retain);
        break;
      }
      case 8:
        onSubscribe(socket, body);
        break;
      case 10: {
        const id = body.getUint16(0);
        const codes: number[] = [];
        for (let at = skipProperties(body, 2); at < body.byteLength; ) {
          const [topic, next] = readText(body, at);
          at = next;
          record(socket, `UNSUBSCRIBE ${topic}`);
          socket.data.topics.delete(topic);
          codes.push(0);
        }
        socket.send(Uint8Array.of(0xb0, 3 + codes.length, id >> 8, id & 0xff, 0, ...codes));
        break;
      }
      case 12:
        socket.send(Uint8Array.of(0xd0, 0));
        break;
      case 14: {
        // No reason code is "Normal disconnection" (0x00).
        const code = body.byteLength > 0 ? body.getUint8(0) : 0;
        record(socket, code === 0 ? "DISCONNECT" : `DISCONNECT ${code}`);
        // The client leaves on purpose: its will is not published, unless it
        // asks for that.
        if (code !== 0x04) socket.data.will = undefined;
        break;
      }
    }
  }

  const server = bunServe({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request: Request, bun: Upgrader) {
      // Bun answers the `mqtt` subprotocol the client asks for by itself.
      const data: SocketData = {
        pending: new Uint8Array(0),
        topics: new Map(),
        clientId: undefined,
        will: undefined,
        packets: [],
      };
      return bun.upgrade(request, { data }) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open(socket: Socket) {
        sockets.add(socket);
        everConnected.push(socket.data.packets);
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

    /** Per connection there was, open or closed, in the order they opened:
     *  every packet its client sent, oldest first. Packets on one connection
     *  reach the broker in the order they were sent; across connections they
     *  need not. */
    connectionPackets: (): string[][] => everConnected.map((packets) => [...packets]),

    /** How many of the packets sent so far start with `prefix`. */
    count: (prefix: string): number => log.filter((packet) => packet.startsWith(prefix)).length,

    /** How many clients have a socket open to the broker right now. */
    connections: (): number => sockets.size,

    /** The wills the broker holds right now, one per open connection that
     *  carries one, as `topic payload` with ` retain` when retained, sorted. */
    heldWills: (): string[] =>
      [...sockets]
        .flatMap(({ data: { will } }) => (will ? [describe(will.topic, will.payload, will.retain)] : []))
        .sort(),

    /** Answer a SUBSCRIBE for `topic` with the failure code from now on. */
    refuse: (topic: string): void => void refused.add(topic),

    /** Accept every topic again. */
    acceptAll: (): void => refused.clear(),

    /** Keep the SUBACKs back until `release()`. */
    holdAnswers: (): void => {
      holding = true;
    },

    /** From now on take `ms` over each SUBSCRIBE, as a broker under load
     *  does: its subscriptions exist, and its SUBACK goes out, only after
     *  that. A message published meanwhile does not reach them. What else the
     *  client sends is taken at once. */
    answerSubscribesAfter: (ms: number): void => {
      subscribeDelay = ms;
    },

    /** Send the SUBACKs kept back, and answer at once from now on. */
    release(): void {
      holding = false;
      for (const send of heldBack.splice(0)) send();
    },

    /** From now on send a message once for every filter of a connection that
     *  matches it, each copy with that filter's subscription identifier, not
     *  once per connection with all of them. */
    copyPerSubscription: (): void => {
      perSubscription = true;
    },

    /** From now on say in every CONNACK that subscription identifiers are not
     *  taken, tag no PUBLISH with one, and close the connection of a client
     *  whose SUBSCRIBE carries one. */
    withoutSubscriptionIds: (): void => {
      tagging = false;
    },

    /** From now on speak MQTT 3.1.1 only: refuse every MQTT 5 CONNECT the
     *  way `refusal` says, and close its connection. */
    speakOnly311: (refusal: Mqtt5Refusal): void => {
      only311 = refusal;
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

/** A PUBLISH at QoS 0, with or without the RETAIN flag, carrying `ids` as its
 *  Subscription Identifier properties (0x0B, one each). */
function publishPacket(topic: string, payload: string, retain: boolean, ids: number[]): Uint8Array {
  const name = new TextEncoder().encode(topic);
  const properties = concat(...ids.map((id) => concat(Uint8Array.of(0x0b), varint(id))));
  const body = concat(
    Uint8Array.of(name.length >> 8, name.length & 0xff),
    name,
    varint(properties.length),
    properties,
    new TextEncoder().encode(payload),
  );
  return concat(Uint8Array.of(0x30 | (retain ? 1 : 0)), varint(body.length), body);
}

/** A Variable Byte Integer (MQTT 5 §1.5.5): a remaining length, a property
 *  length, a subscription identifier. */
function varint(value: number): Uint8Array {
  const out: number[] = [];
  let rest = value;
  do {
    const digit = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? digit | 0x80 : digit);
  } while (rest > 0);
  return Uint8Array.from(out);
}

/** The Variable Byte Integer at `at`, and the offset after it. */
function readVarint(view: DataView, at: number): [number, number] {
  let value = 0;
  let next = at;
  for (let shift = 0; ; shift += 7) {
    const byte = view.getUint8(next);
    next += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, next];
  }
}

/** The offset after the properties (a length, then that many bytes) at `at`. */
function skipProperties(view: DataView, at: number): number {
  const [length, start] = readVarint(view, at);
  return start + length;
}

/** The Subscription Identifier among the properties at `at` (a SUBSCRIBE's),
 *  and the offset after the properties. */
function readSubscriptionId(view: DataView, at: number): [number | undefined, number] {
  const [length, start] = readVarint(view, at);
  const end = start + length;
  let id: number | undefined;
  for (let next = start; next < end; ) {
    const property = view.getUint8(next);
    if (property === 0x0b) {
      [id, next] = readVarint(view, next + 1);
    } else if (property === 0x26) {
      // A User Property: two strings.
      next = readText(view, readText(view, next + 1)[1])[1];
    } else {
      break;
    }
  }
  return [id, end];
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
