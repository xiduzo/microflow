// Browser MQTT-over-WebSocket connections for the cloud host (ADR-0009 Phase 3).
//
// The desktop's `MqttManager` (native sockets) has no browser analog: a browser
// can only speak MQTT over WS/WSS. This is that analog — one `mqtt.js` client
// per broker id, reused across publishes/subscribes, speaking MQTT 5. Every
// topic filter the broker holds has a subscription identifier of its own, and
// an inbound message goes to the filters whose identifiers it carries: once to
// each, whether the broker sends one copy for all of them or one per filter.
// A retained replay goes only to the filters that have not had its topic yet.
// The desktop's `MqttBroker` routes by the same rules (`route` in
// `src-tauri/src/mqtt/broker.rs`) and the same filter matching
// (`fixtures/topic-filter.json`).
//
// `mqtt.js` is used as a transport only. It keeps the link up (it reconnects by
// itself) and stores, without a bound, every publish it is handed while the
// link is down. Which publishes it is handed then is decided here
// ({@link BrokerConnections.publish}), and so is which topics a broker holds,
// because only the subscribe callback says whether the broker accepted a topic.
//
// A connection leaves its wills with the broker ({@link BrokerConnections.setWills}):
// the messages the broker publishes when a link ends without a DISCONNECT, as
// the desktop's links do (`MqttBroker::set_will` / `renew_link`). MQTT gives a
// link one will, fixed when the link is opened. The connection's link carries
// the first; each further one is carried by a will link, a client of its own
// that subscribes to nothing and publishes only its goodbye, right before its
// DISCONNECT. A link that is up is renewed for a new will make-before-break.

import mqtt from "mqtt";
import { realTimers, type Timers } from "@/lib/timers";
import { brokerProblem } from "./mqtt-refusal";
import { isTopicName, topicMatches } from "./topic-filter";

/** The connection half of an `MqttBrokerConfig` — what a client needs. */
export type BrokerConn = {
  id: string;
  url: string;
  username?: string;
  password?: string;
};

/** Invoked for each inbound message meant for a subscription. `topic` is the
 *  topic the message was published on, which for a filter with a wildcard is
 *  not the filter. */
export type MqttMessageHandler = (topic: string, payload: Uint8Array) => void;

/** Told whether the broker holds a subscription: `true` once it accepted the
 *  topic, `false` when it refused one it held or was asked for. */
export type SubscriptionWatcher = (held: boolean) => void;

/**
 * How long a connection that is being closed may wait for the answers the
 * broker still owes it (a SUBACK, an UNSUBACK) before it says DISCONNECT. After
 * that it is cut, so a broker that never answers does not keep a socket open.
 */
export const CLOSE_GRACE_MS = 2000;

/**
 * How long a connection that is being opened keeps the publishes made for it
 * with `whenDown: "drop"`. One that has not connected by then keeps none.
 */
export const OPENING_PUBLISH_MS = 5000;

/**
 * How long a link opened to carry a new will ({@link BrokerConnections.setWills})
 * may take to connect. One that has not by then is closed, and the link that
 * is up keeps the will it has until the will changes again or that link is
 * repaired.
 */
export const RENEW_MS = 5000;

/** The highest subscription identifier MQTT 5 allows (§3.8.2.1.2). */
const MAX_SUBSCRIPTION_ID = 268_435_455;

/**
 * A message the broker publishes for a link that ends without a DISCONNECT
 * (MQTT 5 §3.1.2.5), at QoS 0: the tab crashed or was killed, the network
 * went, the page was frozen past the keep-alive. Its payload is UTF-8 text, as
 * every cloud payload is.
 */
export type Will = { topic: string; payload: string; retain: boolean };

const sameWill = (a: Will | undefined, b: Will | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.topic === b.topic &&
    a.payload === b.payload &&
    a.retain === b.retain);

/** The longest string a CONNECT field holds: a two-byte length, in bytes. */
const MAX_FIELD = 0xffff;

/** Whether a CONNECT can carry `will`: a topic name (no wildcard, not empty),
 *  and a topic and a payload each within a CONNECT field. */
const fitsAWill = (will: Will): boolean =>
  isTopicName(will.topic) &&
  new TextEncoder().encode(will.topic).length <= MAX_FIELD &&
  new TextEncoder().encode(will.payload).length <= MAX_FIELD;

/** What a client is opened for: the `link` a connection subscribes and
 *  publishes on, or a `will` link that only carries a will. */
export type ClientPurpose = "link" | "will";

const randomClientId = (purpose: ClientPurpose): string =>
  `microflow-web-${purpose === "will" ? "will-" : ""}${Math.random().toString(16).slice(2, 10)}`;

/** An empty username or password field means none. */
const credential = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

/** The Subscription Identifier property of a PUBLISH as `mqtt-packet` parses
 *  it: absent, one, or several. */
const identifiers = (property: number | number[] | undefined): readonly number[] =>
  property === undefined ? [] : Array.isArray(property) ? property : [property];

/**
 * The minimal surface of an `mqtt.js` client that {@link BrokerConnections} uses
 * — the seam that makes the cloud path unit-testable: a stub stands in for a real
 * connection (the production client needs a live WS/WSS broker). Only what the
 * connections actually use is listed.
 */
export interface MqttClientLike {
  /** The broker accepted the connection and the link is up. */
  readonly connected: boolean;
  /** Whether the broker of the link that is up takes subscription
   *  identifiers: its CONNACK did not say it does not (MQTT 5 §3.2.2.3.12). */
  readonly subscriptionIds: boolean;
  /** Every time the broker accepts the connection: the first time and after
   *  each reconnect. `connected` is already true a moment before it. */
  on(event: "connect", handler: () => void): void;
  /** A message the broker sent. `retain` is its RETAIN flag: set on the
   *  retained messages a SUBSCRIBE is answered with, clear on a message sent
   *  to a subscription that already exists. `ids` are the subscription
   *  identifiers it carries: of every subscription it is for, or none when
   *  the subscriptions it is for have none. */
  on(
    event: "message",
    handler: (topic: string, payload: Uint8Array, retain: boolean, ids: readonly number[]) => void,
  ): void;
  on(event: "error", handler: (error: unknown) => void): void;
  /** Subscribe to `topic`, with subscription identifier `id` unless it is
   *  `undefined`. The callback is called once. It gets no error when the
   *  broker accepted the topic. It gets an error that carries the broker's
   *  SUBACK as `packet` when the broker refused the topic (a reason code of
   *  0x80 or more), and an error without one when the link closed before the
   *  broker answered. */
  subscribe(topic: string, id: number | undefined, callback: (error?: Error | null) => void): void;
  unsubscribe(topic: string): void;
  publish(topic: string, message: string, opts: { retain: boolean }): void;
  /** `end(true)` closes at once: what was just published may never be sent.
   *  `end()` sends what was written and a DISCONNECT first, the DISCONNECT
   *  only once the broker has answered every SUBSCRIBE and UNSUBSCRIBE; `done`
   *  is called when it is out. An `end(true)` after an `end()` that is still
   *  waiting cuts the connection there and then, without a DISCONNECT.
   *
   *  The DISCONNECT tells the broker to drop the link's will. A link that is
   *  up and closed without one leaves the broker to publish it. */
  end(force?: boolean, done?: () => void): void;
}

/** Creates the {@link MqttClientLike} for a broker. The default wraps
 *  `mqtt.connect`; tests inject a stub so no real broker is needed. `create`
 *  may throw: `mqtt.connect` does on a URL it cannot open a WebSocket to.
 *
 *  Every client has a client id of its own, never one an earlier client had:
 *  a broker ends the connection of a client whose id connects again, and
 *  publishes its will. Every link the client opens, the first and each one
 *  it reconnects with, carries `will`. A `will` client is never subscribed,
 *  and published on once at most: its will, before it says DISCONNECT. */
export interface MqttClientFactory {
  create(conn: BrokerConn, will: Will | undefined, purpose: ClientPurpose): MqttClientLike;
}

/** The production factory: one real `mqtt.js` client per link, over WS/WSS. */
export const defaultMqttClientFactory: MqttClientFactory = {
  create(conn: BrokerConn, will: Will | undefined, purpose: ClientPurpose): MqttClientLike {
    const client = mqtt.connect(conn.url, {
      // Subscription identifiers, which say what subscription a message is
      // for, are MQTT 5's. A broker that speaks only 3.1.1 refuses the link.
      protocolVersion: 5,
      clientId: randomClientId(purpose),
      username: credential(conn.username),
      password: credential(conn.password),
      // `mqtt.js` puts it on the CONNECT of every link the client opens.
      will: will && { topic: will.topic, payload: will.payload, retain: will.retain, qos: 0 },
      reconnectPeriod: 4000,
      // A broker forgets a clean session's subscriptions when the link drops,
      // and `BrokerConnections` makes them again on every connect. `mqtt.js`
      // must not also do that: its own copy is made without a callback, so a
      // refusal would go unseen, and it answers a later subscribe for a topic
      // it remembers without asking the broker.
      clean: true,
      resubscribe: false,
      // Outside a browser, use the runtime's own `WebSocket` like a browser
      // build does, not the `ws` package (whose stream Bun 1.3 does not have).
      // `mqtt.js` reads this option only when it is not in a browser, so it
      // changes nothing in the app; it lets `mqtt-client.real.test.ts` drive
      // this very factory.
      forceNativeWebSocket: true,
    });
    // What the CONNACK of the link said, read as it arrives: `connected` is
    // true before the `connect` event, and a SUBSCRIBE may go out between.
    let subscriptionIds = true;
    client.on("packetreceive", (packet) => {
      if (packet.cmd !== "connack") return;
      subscriptionIds = packet.properties?.subscriptionIdentifiersAvailable !== false;
    });
    return {
      get connected() {
        return client.connected;
      },
      get subscriptionIds() {
        return subscriptionIds;
      },
      on(event: "connect" | "message" | "error", handler: (...args: never[]) => void): void {
        if (event === "message") {
          const onMessage = handler as (
            topic: string,
            payload: Uint8Array,
            retain: boolean,
            ids: readonly number[],
          ) => void;
          client.on("message", (topic, payload, packet) =>
            onMessage(topic, payload, packet.retain, identifiers(packet.properties?.subscriptionIdentifier)),
          );
          return;
        }
        // Each event with its own handler type, as the overloads above pair
        // them; `mqtt.js` pairs them the same way.
        client.on(event as "connect", handler as () => void);
      },
      subscribe: (topic, id, callback) =>
        void client.subscribe(
          topic,
          id === undefined ? { qos: 0 } : { qos: 0, properties: { subscriptionIdentifier: id } },
          callback,
        ),
      unsubscribe: (topic) => void client.unsubscribe(topic),
      publish: (topic, message, opts) => void client.publish(topic, message, opts),
      end(force = false, done) {
        // `mqtt.js` ignores an `end(true)` while an `end()` waits for the
        // broker's answers. Closing the socket under it is what cuts it: the
        // client is ending, so it does not reconnect.
        if (force && client.disconnecting) client.stream.destroy();
        else client.end(force, done);
      },
    };
  },
};

/** One topic the broker is asked to hold. */
type Subscription = {
  /** Its subscription identifier: the session's own for this filter, for as
   *  long as the filter is asked of the broker, over every link. */
  id: number;
  handler: MqttMessageHandler;
  watcher: SubscriptionWatcher;
  /** The broker accepted it. Stays true across a dropped link, which the
   *  session repairs by subscribing again on reconnect. */
  held: boolean;
  /** A SUBSCRIBE is waiting for its answer. The client answers every one: with
   *  the broker's SUBACK, or with an error when the link closes first. */
  asked: boolean;
  /** Why the last SUBSCRIBE failed, so the same failure is logged once. */
  failure: string | undefined;
  /** The topics it had a message on since its last SUBSCRIBE went out: a
   *  retained replay on one of them is not news to it. */
  seen: Set<string>;
};

/** A publish as the client takes it. */
type Outbound = { topic: string; text: string; retain: boolean };

/** A client opened beside another to carry a new will, until it connects and
 *  takes over, or {@link RENEW_MS} runs out. */
type Renewal<W extends Will | undefined> = { client: MqttClientLike; will: W; timeout: unknown };

/** A client that carries one of a connection's wills: no subscription, and
 *  one publish only, its goodbye, right before its DISCONNECT
 *  ({@link BrokerConnections.farewell}). It keeps its link up the way the
 *  connection's link does, and is never reported as the broker's status. */
type WillLink = {
  /** The topic of its will, which names it among the connection's. */
  topic: string;
  client: MqttClientLike;
  /** The will `client` was created with. */
  carried: Will;
  /** The will it is to carry. */
  wanted: Will;
  renewal: Renewal<Will> | undefined;
};

/** One broker connection and the topics asked of it. It lasts until the broker
 *  is configured differently or removed. */
type Session = {
  conn: BrokerConn;
  /** The client of the link in use: every publish, SUBSCRIBE and UNSUBSCRIBE
   *  goes to it, and only what it receives is delivered. */
  client: MqttClientLike;
  /** The will `client` was created with, which every link it opens carries. */
  carried: Will | undefined;
  /** The wills the connection leaves with the broker
   *  ({@link BrokerConnections.setWills}): the first for `client`, each other
   *  one for a will link. */
  wills: Will[];
  /** A client opened beside `client` to carry the first will. */
  renewal: Renewal<Will | undefined> | undefined;
  /** The will links, by the topic of their will. */
  willLinks: Map<string, WillLink>;
  /** The number of the link in use: one higher each time `client` connects.
   *  A renewal keeps it. */
  link: number;
  topics: Map<string, Subscription>;
  /** The subscription identifier the next new subscription gets. */
  nextId: number;
  /** While the connection is being opened, for {@link OPENING_PUBLISH_MS} at
   *  most: the `whenDown: "drop"` publishes made for it, to send on its first
   *  connect, and the timer that ends the wait. Gone after that. */
  opening: { publishes: Outbound[]; timeout: unknown } | undefined;
  /** What the broker did wrong that was logged already: a message without a
   *  subscription identifier, one whose identifier names a filter its topic
   *  does not match. */
  faults: Set<string>;
};

/** What a publish does when the link to its broker is down. */
export type PublishOptions = {
  retain: boolean;
  /**
   * - `"keep"`: the client stores it and sends it when the link is back,
   *   however long that takes. For the few publishes that must not be lost to
   *   an outage. A connection closed while its link is down takes them with it.
   * - `"drop"`: it is not sent late. One exception: a connection that is being
   *   opened for the first time keeps them for {@link OPENING_PUBLISH_MS} and
   *   sends them, in order, when it connects in that time, so the publish that
   *   opened a connection is not lost to the opening.
   */
  whenDown: "keep" | "drop";
};

/** What became of a publish: `sent` on a link that is up, `kept` for a link
 *  that is down or still opening, `dropped`, or `invalid` when its topic is
 *  not a topic name (a wildcard, an empty one), which no broker takes. */
export type Published = "sent" | "kept" | "dropped" | "invalid";

/** What {@link BrokerConnections.configure} left a broker with. */
export type Configured = {
  /** There is a connection to use. */
  open: boolean;
  /** It is not the connection from before the call: one was opened, replaced
   *  or closed. */
  changed: boolean;
};

const sameConn = (a: BrokerConn, b: BrokerConn): boolean =>
  a.url === b.url &&
  credential(a.username) === credential(b.username) &&
  credential(a.password) === credential(b.password);

/** The broker answered the SUBSCRIBE with a failure code, as opposed to a link
 *  that was lost before it answered: `mqtt.js` puts the SUBACK on the error
 *  (`ErrorWithSubackPacket`) only when there was one. */
const isRefusal = (error: Error): boolean => (error as { packet?: unknown }).packet !== undefined;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The broker sessions of the browser host: one connection per broker id, and
 * for each the topics it should hold.
 *
 * A subscription is **held** once the broker accepted it. A topic asked for
 * while the link is down, or one the broker refused, is subscribed on the next
 * connect; so is every held topic, because a broker forgets them when the link
 * drops. Callers learn what the broker holds through the
 * {@link SubscriptionWatcher} they pass to {@link subscribe}.
 *
 * A connection's link carries the first will it is given ({@link setWills}),
 * and a will link of its own carries each other one. A link that is up and
 * carries another will is **renewed**: a new link is opened beside it, takes
 * over (the connection's link: every subscription), and the old one then says
 * DISCONNECT, which drops the old will. To the callers the connection stays up
 * throughout: no watcher is called with `false`, and a subscription is not
 * handed a retained message again that it had.
 *
 * A failure is logged once, until what failed works again or fails differently.
 */
export class BrokerConnections {
  private readonly sessions = new Map<string, Session>();
  /** Why a broker's connection could not be opened, per broker id. */
  private readonly unopened = new Map<string, string>();

  constructor(
    /** Inject a stub {@link MqttClientFactory} in tests; production uses the
     *  real `mqtt.connect` wrapper. */
    private readonly factory: MqttClientFactory = defaultMqttClientFactory,
    /** Called before a connection whose link is up is replaced or closed, by
     *  {@link configure} or {@link disposeAll}: the last moment to
     *  {@link publish} on it. What is published then is sent before the
     *  connection closes. It may throw: the connection closes all the same. */
    private readonly beforeLeaving: (brokerId: string) => void = () => {},
    /** What the waits of a connection run on: the one for it to open
     *  ({@link OPENING_PUBLISH_MS}), the one for a link to close
     *  ({@link CLOSE_GRACE_MS}) and the one for a link renewed for a will to
     *  connect ({@link RENEW_MS}). */
    private readonly timers: Timers = realTimers,
  ) {}

  /**
   * Make the connection for `brokerId` the one `conn` describes: open it when
   * there is none, replace it when the settings differ, close it when `conn` is
   * `undefined`. Nothing is thrown: a `conn` no connection can be opened for
   * (see {@link MqttClientFactory.create}) leaves the broker without one, and
   * the next call tries again.
   *
   * The topics a replaced or closed connection held are gone with it,
   * unannounced: no watcher is called, no message it still receives reaches a
   * handler, and a new connection starts with none.
   */
  configure(brokerId: string, conn: BrokerConn | undefined): Configured {
    const session = this.sessions.get(brokerId);
    if (session && conn && sameConn(session.conn, conn)) return { open: true, changed: false };
    if (session) this.close(brokerId, session);
    if (conn === undefined) this.unopened.delete(brokerId);
    const open = conn !== undefined && this.open(brokerId, conn);
    return { open, changed: session !== undefined || open };
  }

  /** Publish a payload on the broker's connection; without one it goes
   *  nowhere. Our cloud payloads are UTF-8 text bytes, sent as text. What
   *  becomes of a publish made while the link is down is the caller's choice
   *  ({@link PublishOptions.whenDown}). A topic that is not a topic name
   *  ({@link isTopicName}) is never sent: a broker closes the connection of a
   *  client that publishes on one, and every subscription on it with it. */
  publish(
    brokerId: string,
    topic: string,
    payload: Uint8Array,
    { retain, whenDown }: PublishOptions,
  ): Published {
    if (!isTopicName(topic)) return "invalid";
    const session = this.sessions.get(brokerId);
    if (!session) return "dropped";
    const text = new TextDecoder().decode(payload);
    if (whenDown === "drop") {
      // Behind the ones already waiting for the first connect, also in the
      // moment the link is up and the client has not said so yet.
      if (session.opening) {
        session.opening.publishes.push({ topic, text, retain });
        return "kept";
      }
      if (!session.client.connected) return "dropped";
    }
    session.client.publish(topic, text, { retain });
    return session.client.connected ? "sent" : "kept";
  }

  /**
   * Ask the broker's session to hold the topic filter `topic` and route the
   * messages meant for it to `handler`, replacing any handler and watcher the
   * filter had.
   *
   * A message reaches the handler of each filter it is meant for once,
   * whatever number of copies of it the broker sends:
   *
   * - The filter is subscribed with a subscription identifier of its own, the
   *   same on every link, and the broker tags each message with the
   *   identifiers of the subscriptions it is for (MQTT 5 §3.3.4): one copy
   *   with all of them (HiveMQ), or one copy per subscription with its own
   *   (mosquitto 2, EMQX). A message goes to the filters it names whose
   *   filter matches its topic. A message that names none (a broker that
   *   takes no identifiers, or a fault in one) goes to every filter that
   *   matches its topic, and that is logged once.
   * - A retained message (flagged RETAIN) is the broker's answer to a
   *   SUBSCRIBE: it goes only to a filter that has had no message on its
   *   topic since its own SUBSCRIBE went out. So a link that took the
   *   subscriptions over, and the broker's replay to it, is not news.
   *
   * A topic the broker already holds stays as it is on the broker and
   * `watcher(true)` is called at once; otherwise the topic is subscribed now,
   * or on the next connect when the link is down or the broker refuses it.
   * Without a session for `brokerId` nothing happens.
   */
  subscribe(
    brokerId: string,
    topic: string,
    handler: MqttMessageHandler,
    watcher: SubscriptionWatcher,
  ): void {
    const session = this.sessions.get(brokerId);
    if (!session) return;
    const existing = session.topics.get(topic);
    if (existing) {
      existing.handler = handler;
      existing.watcher = watcher;
      if (existing.held) watcher(true);
      else this.request(brokerId, session, topic, existing);
      return;
    }
    const subscription: Subscription = {
      id: session.nextId,
      handler,
      watcher,
      held: false,
      asked: false,
      failure: undefined,
      seen: new Set(),
    };
    session.nextId = session.nextId === MAX_SUBSCRIPTION_ID ? 1 : session.nextId + 1;
    session.topics.set(topic, subscription);
    this.request(brokerId, session, topic, subscription);
  }

  /**
   * Say the goodbye `goodbye` on `brokerId`. When a will link carries it as
   * its will and is up, that link publishes it and then says DISCONNECT: both
   * on one connection, so the broker has the goodbye before it drops the will.
   * The will link is gone after that. Otherwise the goodbye is published on
   * the connection's link like a `whenDown: "keep"` {@link publish}, and what
   * that gives is returned.
   */
  farewell(brokerId: string, goodbye: Will): Published {
    const session = this.sessions.get(brokerId);
    const link = session?.willLinks.get(goodbye.topic);
    if (
      session &&
      link?.client.connected &&
      (sameWill(link.carried, goodbye) || sameWill(link.wanted, goodbye))
    ) {
      session.willLinks.delete(goodbye.topic);
      if (link.renewal) {
        this.timers.clear(link.renewal.timeout);
        link.renewal.client.end(true);
        link.renewal = undefined;
      }
      link.client.publish(goodbye.topic, goodbye.payload, { retain: goodbye.retain });
      this.disconnect(link.client);
      return "sent";
    }
    return this.publish(brokerId, goodbye.topic, new TextEncoder().encode(goodbye.payload), {
      retain: goodbye.retain,
      whenDown: "keep",
    });
  }

  /**
   * Make `wills` what `brokerId`'s connection leaves with the broker, to
   * publish should a link end without a DISCONNECT. A will no CONNECT can
   * carry (its topic is not a topic name, or a field is longer than a CONNECT
   * holds) is left out, and so is one on the topic of a will before it.
   * Without a connection nothing happens, and a new connection starts with
   * none.
   *
   * The connection's link carries the first. Each other one is carried by a
   * will link: a client opened for it (a client id of its own) that
   * subscribes to nothing and publishes one message only, its goodbye, right
   * before its DISCONNECT ({@link farewell}). A will link is opened when its
   * will is given, renewed when the will on its topic changes, and closed
   * when no will is on its topic any more, or the connection is closed: with
   * a DISCONNECT, which drops its will, when the connection's link is up and
   * so said the goodbye; cut when it is down, so that the broker says the
   * will. A will link that became the connection link's is kept until that
   * link carries it.
   *
   * A link carries the will it was opened with. One that is up and carries
   * another is renewed (see the class comment); one that is down, or still
   * being opened, is renewed once it is up. Should the new link not connect
   * within {@link RENEW_MS}, the link in use keeps the will it has, until the
   * will changes again or that link is repaired.
   */
  setWills(brokerId: string, wills: readonly Will[]): void {
    const session = this.sessions.get(brokerId);
    if (!session) return;
    const topics = new Set<string>();
    session.wills = wills.filter((will) => {
      if (!fitsAWill(will) || topics.has(will.topic)) return false;
      topics.add(will.topic);
      return true;
    });
    this.renew(brokerId, session);
    this.arrangeWillLinks(brokerId, session);
  }

  /**
   * The number of the link a publish made now on `brokerId` goes out on: the
   * link that is up, or the next one while the link is down or being opened.
   * Each new link of a connection has a number one higher than the one before
   * it, starting at 1; a link renewed for a will keeps the number. A
   * subscription's watcher is told on the link it is held on. `0` without a
   * connection. Will links have no number.
   */
  link(brokerId: string): number {
    const session = this.sessions.get(brokerId);
    if (!session) return 0;
    return session.client.connected ? session.link : session.link + 1;
  }

  /** Stop routing `topic` and have the broker let go of it. Its handler and
   *  watcher are not called again, whatever the broker still sends. */
  unsubscribe(brokerId: string, topic: string): void {
    const session = this.sessions.get(brokerId);
    const subscription = session?.topics.get(topic);
    if (!session || !subscription) return;
    session.topics.delete(topic);
    // With the link down the broker holds nothing, and the topic is no longer
    // one to subscribe on connect.
    if (session.client.connected && (subscription.held || subscription.asked)) {
      session.client.unsubscribe(topic);
    }
  }

  /** Close every connection (host teardown). A connection that cannot be
   *  closed does not keep the others open: the first error is thrown once
   *  every one of them was closed. */
  disposeAll(): void {
    const failures: unknown[] = [];
    for (const [brokerId, session] of this.sessions) {
      try {
        this.close(brokerId, session);
      } catch (error) {
        failures.push(error);
      }
    }
    this.unopened.clear();
    if (failures.length > 0) throw failures[0];
  }

  /** Open the connection for `conn`; `false` when that cannot be done. */
  private open(brokerId: string, conn: BrokerConn): boolean {
    let client: MqttClientLike;
    try {
      client = this.factory.create(conn, undefined, "link");
    } catch (error) {
      const failure = `${conn.url}: ${reason(error)}`;
      if (this.unopened.get(brokerId) !== failure) {
        this.unopened.set(brokerId, failure);
        console.warn(`[mqtt] broker ${brokerId} cannot be connected to at ${failure}`);
      }
      return false;
    }
    this.unopened.delete(brokerId);
    const session: Session = {
      conn,
      client,
      carried: undefined,
      wills: [],
      renewal: undefined,
      willLinks: new Map(),
      link: 0,
      topics: new Map(),
      nextId: 1,
      opening: {
        publishes: [],
        // Not opened in time: what was kept for it is old news by now.
        timeout: this.timers.set(() => (session.opening = undefined), OPENING_PUBLISH_MS),
      },
      faults: new Set(),
    };
    this.sessions.set(brokerId, session);
    this.listen(brokerId, session, client);
    return true;
  }

  /** Take what `client`, one of `session`'s clients, reports. Only the client
   *  of the link in use is listened to, and a renewal's first connect. */
  private listen(brokerId: string, session: Session, client: MqttClientLike): void {
    let lastError: string | undefined;
    client.on("connect", () => {
      lastError = undefined;
      if (this.sessions.get(brokerId) !== session) return;
      if (session.renewal?.client === client) this.takeOver(brokerId, session);
      else if (session.client === client) this.linkUp(brokerId, session);
    });
    client.on("message", (topic, payload, retain, ids) => {
      // A link that was renewed: its replacement holds the subscriptions.
      if (session.client !== client) return;
      // Taken first, so that a handler which changes the subscriptions
      // changes nothing for this message.
      for (const subscription of this.addressees(brokerId, session, topic, ids)) {
        const news = !(retain && subscription.seen.has(topic));
        subscription.seen.add(topic);
        if (news) subscription.handler(topic, new Uint8Array(payload));
      }
    });
    client.on("error", (error: unknown) => {
      // The client retries by itself; the same error every few seconds is one
      // thing to know.
      if (lastError === reason(error)) return;
      lastError = reason(error);
      const problem = brokerProblem(error);
      if (problem) console.warn(`[mqtt] broker ${brokerId}: ${problem}`);
      else console.warn(`[mqtt] broker ${brokerId} error:`, error);
    });
  }

  /**
   * The subscriptions a message on `topic` tagged with `ids` is for (see
   * {@link subscribe}): each subscription named once, however often it is
   * named, and only when its filter matches the topic. A message tagged with
   * no identifier is for every subscription whose filter matches.
   */
  private addressees(
    brokerId: string,
    session: Session,
    topic: string,
    ids: readonly number[],
  ): Subscription[] {
    const all = [...session.topics];
    if (ids.length === 0) {
      this.fault(
        brokerId,
        session,
        "untagged",
        `[mqtt] broker ${brokerId} sent a message without a subscription identifier; such messages go to every subscription whose filter matches their topic, once per copy`,
      );
      return all.filter(([filter]) => topicMatches(filter, topic)).map(([, subscription]) => subscription);
    }
    const named = new Set(ids);
    const addressees: Subscription[] = [];
    for (const [filter, subscription] of all) {
      if (!named.has(subscription.id)) continue;
      if (topicMatches(filter, topic)) addressees.push(subscription);
      else {
        this.fault(
          brokerId,
          session,
          `mismatch ${filter}`,
          `[mqtt] broker ${brokerId} sent a message on ${topic} for the subscription to ${filter}, which does not match it; it is not delivered there`,
        );
      }
    }
    return addressees;
  }

  /** Log what the broker did wrong, once per session and `kind`. */
  private fault(brokerId: string, session: Session, kind: string, message: string): void {
    if (session.faults.has(kind)) return;
    session.faults.add(kind);
    console.warn(message);
  }

  /** The link in use came up: the session's first, or one its client
   *  repaired. It is a new link, which starts with nothing subscribed. */
  private linkUp(brokerId: string, session: Session): void {
    const { client, opening } = session;
    session.link += 1;
    if (opening) {
      session.opening = undefined;
      this.timers.clear(opening.timeout);
      for (const { topic, text, retain } of opening.publishes) {
        client.publish(topic, text, { retain });
      }
    }
    // A topic already asked on it (between the broker's CONNACK and this
    // event) is not asked twice: the broker would send its retained messages
    // twice.
    for (const [topic, subscription] of session.topics) {
      this.request(brokerId, session, topic, subscription);
    }
    // It carries the will its client was made with, which may be old by now.
    this.renew(brokerId, session);
  }

  /**
   * Open a link beside the one in use to carry the session's first will, when
   * the one in use is up and carries another and no such link is being opened
   * already. It takes over once it connects ({@link takeOver}); one that does
   * not within {@link RENEW_MS} is closed.
   */
  private renew(brokerId: string, session: Session): void {
    const will = session.wills[0];
    if (session.renewal || !session.client.connected || sameWill(session.carried, will)) return;
    let client: MqttClientLike;
    try {
      client = this.factory.create(session.conn, will, "link");
    } catch (error) {
      console.warn(`[mqtt] broker ${brokerId}: no new link for its will: ${reason(error)}`);
      return;
    }
    const renewal: Renewal<Will | undefined> = {
      client,
      will,
      timeout: this.timers.set(() => {
        if (session.renewal !== renewal) return;
        session.renewal = undefined;
        // Not connected: the broker took no will from it.
        client.end(true);
        console.warn(`[mqtt] broker ${brokerId}: the new link for its will did not connect; the link in use keeps its will`);
      }, RENEW_MS),
    };
    session.renewal = renewal;
    this.listen(brokerId, session, client);
  }

  /**
   * The link opened to carry the session's first will connected: it becomes
   * the link in use, under the same link number. It subscribes every topic
   * the session holds or is asking for, under the same subscription
   * identifiers, leaving what each subscription has had as it is, so the
   * broker's retained replay is not news to one that had it. Then the old
   * link says DISCONNECT, so the broker drops the old will.
   *
   * The old link stops delivering here; a message sent in the moment between
   * this and the new link's SUBACK is lost, as one sent while a link is down
   * is. When the old link dropped meanwhile the new one is closed, with a
   * DISCONNECT, and the old one is renewed once it is repaired: what it
   * stored for its link is sent when it is.
   */
  private takeOver(brokerId: string, session: Session): void {
    const renewal = session.renewal;
    if (!renewal) return;
    session.renewal = undefined;
    this.timers.clear(renewal.timeout);
    const old = session.client;
    if (!old.connected) {
      renewal.client.end(false);
      return;
    }
    session.client = renewal.client;
    session.carried = renewal.will;
    for (const [topic, subscription] of session.topics) {
      // A SUBSCRIBE still out on the old link is answered there, unheard.
      subscription.asked = false;
      this.request(brokerId, session, topic, subscription, false);
    }
    this.disconnect(old);
    // The will changed again while this link was opened.
    this.renew(brokerId, session);
    // A will link kept until this link carried its will is not needed now.
    this.arrangeWillLinks(brokerId, session);
  }

  /**
   * Make the will links what the session's wills ask for (see
   * {@link setWills}): one for each will after the first, plus the one the
   * first will may still have from before it was first, until the link in use
   * carries it.
   */
  private arrangeWillLinks(brokerId: string, session: Session): void {
    const [first, ...rest] = session.wills;
    const wanted = new Map(rest.map((will) => [will.topic, will] as const));
    const kept = first && session.willLinks.get(first.topic);
    if (kept && !sameWill(session.carried, first)) wanted.set(first.topic, kept.wanted);
    for (const [topic, link] of session.willLinks) {
      if (wanted.has(topic)) continue;
      session.willLinks.delete(topic);
      // The goodbye on its topic was handed to the link in use: said when
      // that link is up; when it is down, the will says it.
      this.closeWillLink(link, session.client.connected);
    }
    for (const [topic, will] of wanted) {
      const link = session.willLinks.get(topic);
      if (link) {
        link.wanted = will;
        this.renewWillLink(brokerId, session, link);
      } else {
        this.openWillLink(brokerId, session, will);
      }
    }
  }

  /** Open a will link for `will`. Its client connects, and reconnects, by
   *  itself, with the backoff of every client. */
  private openWillLink(brokerId: string, session: Session, will: Will): void {
    let client: MqttClientLike;
    try {
      client = this.factory.create(session.conn, will, "will");
    } catch (error) {
      console.warn(`[mqtt] broker ${brokerId}: no link for the will on ${will.topic}: ${reason(error)}`);
      return;
    }
    const link: WillLink = { topic: will.topic, client, carried: will, wanted: will, renewal: undefined };
    session.willLinks.set(will.topic, link);
    this.listenWillLink(brokerId, session, link, client);
  }

  /** Take what `client`, one of `link`'s clients, reports: its connects, and
   *  its errors, logged once each. */
  private listenWillLink(brokerId: string, session: Session, link: WillLink, client: MqttClientLike): void {
    let lastError: string | undefined;
    client.on("connect", () => {
      lastError = undefined;
      if (this.sessions.get(brokerId) !== session || session.willLinks.get(link.topic) !== link) return;
      if (link.renewal?.client === client) this.takeOverWillLink(link);
      else if (link.client === client) this.renewWillLink(brokerId, session, link);
    });
    client.on("error", (error: unknown) => {
      if (lastError === reason(error)) return;
      lastError = reason(error);
      console.warn(`[mqtt] broker ${brokerId}: the link for the will on ${link.topic}:`, error);
    });
  }

  /** Open a client beside `link`'s to carry the will it is to carry, when its
   *  own client is up and carries another (see {@link renew}). */
  private renewWillLink(brokerId: string, session: Session, link: WillLink): void {
    if (link.renewal) {
      if (sameWill(link.renewal.will, link.wanted)) return;
      // Opened for a will that changed again since.
      this.timers.clear(link.renewal.timeout);
      link.renewal.client.end(true);
      link.renewal = undefined;
    }
    if (!link.client.connected || sameWill(link.carried, link.wanted)) return;
    let client: MqttClientLike;
    try {
      client = this.factory.create(session.conn, link.wanted, "will");
    } catch (error) {
      console.warn(`[mqtt] broker ${brokerId}: no new link for the will on ${link.topic}: ${reason(error)}`);
      return;
    }
    const renewal: Renewal<Will> = {
      client,
      will: link.wanted,
      timeout: this.timers.set(() => {
        if (link.renewal !== renewal) return;
        link.renewal = undefined;
        client.end(true);
        console.warn(
          `[mqtt] broker ${brokerId}: the new link for the will on ${link.topic} did not connect; the link in use keeps its will`,
        );
      }, RENEW_MS),
    };
    link.renewal = renewal;
    this.listenWillLink(brokerId, session, link, client);
  }

  /** `link`'s renewal connected: it carries the will from now on, and the
   *  client it replaces says DISCONNECT, or is cut when it is down. */
  private takeOverWillLink(link: WillLink): void {
    const renewal = link.renewal;
    if (!renewal) return;
    link.renewal = undefined;
    this.timers.clear(renewal.timeout);
    const old = link.client;
    link.client = renewal.client;
    link.carried = renewal.will;
    if (old.connected) this.disconnect(old);
    else old.end(true);
  }

  /** Close `link`: with a DISCONNECT, which drops its will, when its goodbye
   *  was `said`; cut otherwise, so the broker publishes its will. */
  private closeWillLink(link: WillLink, said: boolean): void {
    if (link.renewal) {
      this.timers.clear(link.renewal.timeout);
      // Not connected yet: whatever it carries, the broker has none of it.
      link.renewal.client.end(true);
      link.renewal = undefined;
    }
    if (said && link.client.connected) this.disconnect(link.client);
    else link.client.end(true);
  }

  /** Say DISCONNECT on `client`'s link, which is up, once the broker answered
   *  what it owes; cut it after {@link CLOSE_GRACE_MS} when it does not.
   *  `after` is told which of the two it was. */
  private disconnect(client: MqttClientLike, after: (said: boolean) => void = () => {}): void {
    let settled = false;
    const settle = (said: boolean) => {
      if (settled) return;
      settled = true;
      after(said);
    };
    const cut = this.timers.set(() => {
      client.end(true);
      settle(false);
    }, CLOSE_GRACE_MS);
    client.end(false, () => {
      this.timers.clear(cut);
      settle(true);
    });
  }

  /**
   * End `session`. While its link is up, {@link beforeLeaving} may still
   * publish on it, and the client sends that before it disconnects. Whatever
   * `beforeLeaving` throws is logged, and the session is ended all the same.
   *
   * From here on the session delivers nothing: no message reaches a handler,
   * no answer a watcher. The DISCONNECT, which also drops the link's will,
   * waits for the answers the broker still owes, for {@link CLOSE_GRACE_MS}
   * at most; then the connection is cut, and the broker publishes the will. A
   * link being opened for a new will is closed with it. A will link that
   * `beforeLeaving` said farewell on ({@link farewell}) is gone already; the
   * others follow the link: each says DISCONNECT once the link's DISCONNECT is
   * out; each is cut when the link is cut or was down, so that the broker
   * publishes the goodbyes that were not said.
   */
  private close(brokerId: string, session: Session): void {
    const up = session.client.connected;
    try {
      if (up) this.beforeLeaving(brokerId);
    } catch (error) {
      console.warn(`[mqtt] nothing was said on broker ${brokerId} before its connection closed:`, error);
    } finally {
      this.sessions.delete(brokerId);
      session.topics.clear();
      if (session.opening) this.timers.clear(session.opening.timeout);
      session.opening = undefined;
      if (session.renewal) {
        const { client, timeout } = session.renewal;
        session.renewal = undefined;
        this.timers.clear(timeout);
        // A link that is up says DISCONNECT, so its will is dropped.
        client.end(!client.connected);
      }
      const willLinks = [...session.willLinks.values()];
      session.willLinks.clear();
      const closeWillLinks = (said: boolean) => {
        for (const link of willLinks) this.closeWillLink(link, said);
      };
      if (up) this.disconnect(session.client, closeWillLinks);
      else {
        session.client.end(true);
        closeWillLinks(false);
      }
    }
  }

  /** Send the SUBSCRIBE for `topic` on the link in use, unless the link is
   *  down or one is already waiting for its answer. `fresh` for a new link,
   *  whose broker answers it with the filter's retained messages as news;
   *  not for a link that takes over from one that held the topic. */
  private request(
    brokerId: string,
    session: Session,
    topic: string,
    subscription: Subscription,
    fresh = true,
  ): void {
    const { client } = session;
    if (!client.connected || subscription.asked) return;
    subscription.asked = true;
    if (fresh) subscription.seen.clear();
    // A broker that takes no subscription identifiers closes the link of a
    // client that sends one.
    client.subscribe(topic, client.subscriptionIds ? subscription.id : undefined, (error) => {
      // An answer on a link that was since renewed: the SUBSCRIBE on the link
      // in use is answered there.
      if (session.client !== client) return;
      subscription.asked = false;
      // An answer for a topic that was since removed or asked again, or one on
      // a connection that was since replaced, says nothing about what the
      // broker holds now.
      const current =
        this.sessions.get(brokerId) === session && session.topics.get(topic) === subscription;
      if (!current) return;
      if (!error) {
        subscription.held = true;
        subscription.failure = undefined;
        subscription.watcher(true);
        return;
      }
      if (subscription.failure !== error.message) {
        subscription.failure = error.message;
        console.warn(`[mqtt] subscribe ${topic} on ${brokerId} failed, will retry: ${error.message}`);
      }
      // A lost link changes nothing: the next connect subscribes again.
      if (!isRefusal(error)) return;
      subscription.held = false;
      subscription.watcher(false);
    });
  }
}
