// CloudPerformer seam (ADR-0009). The cloud half is tested in isolation: a stub
// `MqttClientFactory` stands in for a real broker, `fetch` is stubbed for the LLM
// transport, and the two runtime re-entry points (LLM result / inbound message)
// are captured as plain callbacks.
//
// The subscription tests play the broker (connect, refuse a topic, drop the
// link, send a message) and assert on what reached it, in order.
//
// Since ADR-0021 the LLM cases here are not a "browser twin" of anything — this
// performer delegates to the one `LlmPerformer` the desktop host holds too
// (`ai/llm-performer.ts`). So these are THE tests for latest-wins cancellation
// and for what re-enters the runtime after a generation.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  BROKER_IDLE_MS,
  CloudPerformer,
  type CloudDeps,
  type FigmaAnnounce,
  type FigmaPublish,
} from "./cloud-performer";
import {
  CLOSE_GRACE_MS,
  OPENING_PUBLISH_MS,
  RENEW_MS,
  type BrokerConn,
  type ClientPurpose,
  type MqttClientFactory,
  type MqttClientLike,
  type Will,
} from "./mqtt-client";
import type { ActiveSub } from "./mqtt-subscriptions";
import { topicMatches } from "./topic-filter";
import { FakeTimers } from "@/lib/fake-timers";
import { resetHostFetch } from "@/ai/endpoint";
import { FIGMA_ANNOUNCE_CASES } from "@/lib/figma-announce-cases";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetHostFetch();
});

function stubFetch(impl: typeof fetch): void {
  globalThis.fetch = impl;
  // `hostFetch` memoises what it resolved, so a stub would leak between tests.
  resetHostFetch();
}

/** An OpenAI chat-completions SSE stream carrying `deltas`, then `[DONE]`. */
function streamResponse(deltas: string[]): Response {
  const frames = deltas.map((delta, index) =>
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: [
        {
          index: 0,
          delta: { content: delta },
          finish_reason: index === deltas.length - 1 ? "stop" : null,
        },
      ],
    }),
  );
  return new Response(`${frames.map((f) => `data: ${f}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(5);
}

/** One packet that reached the broker. */
type Packet =
  | { subscribe: string }
  | { unsubscribe: string }
  | { publish: string; message: string; retain: boolean }
  | { disconnect: true };

const subscribed = (topic: string): Packet => ({ subscribe: topic });
const unsubscribed = (topic: string): Packet => ({ unsubscribe: topic });
const published = (topic: string, message: string, retain = false): Packet => ({
  publish: topic,
  message,
  retain,
});
const DISCONNECT: Packet = { disconnect: true };

/**
 * A broker connection as `mqtt.js` 5 gives it with `clean: true` and
 * `resubscribe: false`, the settings the production factory uses — the stand-in
 * for a real broker behind the `MqttClientFactory` seam. What it does is what
 * `mqtt-client.real.test.ts` sees the real client do.
 *
 * - It starts out connecting. `accept()` is the broker's CONNACK: the link is
 *   up. `connect()` is the `connect` event that follows it.
 * - A packet sent while the link is down is stored and sent with the `connect`
 *   event.
 * - A SUBSCRIBE is answered with a SUBACK: the callback gets no error, or an
 *   error carrying that SUBACK when the broker refuses the topic (0x80).
 * - `drop()` is a lost link: every request still waiting for its answer fails
 *   with "Connection closed", and the broker forgets the session's
 *   subscriptions (clean session). Nothing is subscribed again by itself.
 * - `end(true)` closes at once and sends nothing more, not even what was
 *   stored. `end()` first waits for the answers still out, then sends a
 *   DISCONNECT; called while the link is down it gives up nothing, so what was
 *   stored is still sent if the link comes up. Either way the requests left
 *   unanswered fail with "Connection closed". `end()` calls `done` once the
 *   DISCONNECT is out. An `end(true)` after an `end()` that still waits for
 *   answers cuts the connection: no DISCONNECT, and `done` is not called.
 * - It keeps the will it was made with (`will`); what a broker does with it is
 *   `mqtt-client.real.test.ts`'s to show, on the scripted broker.
 * - It speaks MQTT 5: `deliver` sends one copy of a message tagged with the
 *   subscription identifier of every held filter that matches its topic, as
 *   HiveMQ does. (It matches with the client's own `topicMatches`; the
 *   scripted broker holds the client to a matcher of its own.)
 */
class FakeMqttClient implements MqttClientLike {
  connected = false;
  ended = false;
  readonly subscriptionIds = true;
  /** Every packet the broker received, in order. */
  readonly wire: Packet[] = [];
  /** The topics the broker holds for this connection. */
  readonly held = new Set<string>();
  /** The subscription identifier each topic was subscribed with. */
  private readonly ids = new Map<string, number | undefined>();
  /** Topics the broker refuses to subscribe. */
  readonly refused = new Set<string>();
  /** Hold the broker's SUBACKs back until `ack()`. */
  deferAcks = false;

  private leaving = false;
  private onClosed: () => void = () => {};
  private readonly stored: Array<() => void> = [];
  private readonly unanswered: Array<(lost: Error | null) => void> = [];
  private readonly connectListeners: Array<() => void> = [];
  private readonly messageListeners: Array<
    (topic: string, payload: Uint8Array, retain: boolean, ids: readonly number[]) => void
  > = [];

  constructor(
    readonly conn: BrokerConn,
    /** The will every link of this client carries. */
    readonly will: Will | undefined,
    /** Opened while another client to the same broker was up: a link
     *  renewed for its will. */
    readonly renewal: boolean,
    /** A will link: it carries `will` and nothing else. */
    readonly purpose: ClientPurpose = "link",
  ) {}

  /** The broker took this client's CONNECT at least once. */
  get everConnected(): boolean {
    return this.connects > 0;
  }
  private connects = 0;

  on(event: "connect", handler: () => void): void;
  on(
    event: "message",
    handler: (topic: string, payload: Uint8Array, retain: boolean, ids: readonly number[]) => void,
  ): void;
  on(event: "error", handler: (error: unknown) => void): void;
  on(event: string, handler: (...args: never[]) => void): void {
    if (event === "connect") this.connectListeners.push(handler as () => void);
    if (event === "message") {
      this.messageListeners.push(
        handler as (topic: string, payload: Uint8Array, retain: boolean, ids: readonly number[]) => void,
      );
    }
  }

  subscribe(topic: string, id: number | undefined, callback: (error?: Error | null) => void): void {
    if (this.ended) {
      callback(new Error("client disconnecting"));
      return;
    }
    this.send(() => {
      this.wire.push(subscribed(topic));
      const refused = this.refused.has(topic);
      if (!refused) {
        this.held.add(topic);
        this.ids.set(topic, id);
      }
      const answer = (lost: Error | null) => callback(lost ?? (refused ? subackFailure() : null));
      if (this.deferAcks) this.unanswered.push(answer);
      else answer(null);
    });
  }

  unsubscribe(topic: string): void {
    if (this.ended) return;
    this.send(() => {
      this.wire.push(unsubscribed(topic));
      this.held.delete(topic);
    });
  }

  publish(topic: string, message: string, opts: { retain: boolean }): void {
    if (this.ended) return;
    this.send(() => this.wire.push(published(topic, message, opts.retain)));
  }

  end(force = false, done: () => void = () => {}): void {
    if (this.ended) {
      // Cut under an `end()` that is still waiting for its answers.
      if (force && this.leaving) this.close(false);
      return;
    }
    this.ended = true;
    this.onClosed = done;
    if (force) this.stored.length = 0;
    if (force || this.unanswered.length === 0) this.close(!force);
    else this.leaving = true;
  }

  /** The broker's CONNACK: the link is up, the `connect` event is still to come. */
  accept(): void {
    this.connected = true;
  }

  /** The broker accepts the connection, and the client says so. */
  connect(): void {
    this.connected = true;
    this.connects += 1;
    for (const packet of this.stored.splice(0)) packet();
    for (const listener of this.connectListeners) listener();
  }

  /** The link is lost. */
  drop(): void {
    this.connected = false;
    this.held.clear();
    for (const answer of this.unanswered.splice(0)) answer(new Error("Connection closed"));
  }

  /** The SUBACKs held back by `deferAcks` arrive. */
  ack(): void {
    for (const answer of this.unanswered.splice(0)) answer(null);
    if (this.leaving) this.close(true);
  }

  private close(sayDisconnect: boolean): void {
    this.leaving = false;
    if (sayDisconnect && this.connected) this.wire.push(DISCONNECT);
    this.drop();
    // Only an end that was not cut short says it is done.
    if (sayDisconnect) this.onClosed();
  }

  /** The broker sends a message on `topic`: `retain` for the retained one it
   *  answers a SUBSCRIBE with. */
  deliver(topic: string, text: string, retain = false): void {
    const ids = [...this.held]
      .filter((filter) => topicMatches(filter, topic))
      .flatMap((filter) => this.ids.get(filter) ?? []);
    if (ids.length === 0) return;
    for (const listener of this.messageListeners) {
      listener(topic, new TextEncoder().encode(text), retain, ids);
    }
  }

  private send(packet: () => void): void {
    if (this.connected) packet();
    else this.stored.push(packet);
  }
}

/** What `mqtt.js` passes a subscribe callback when the SUBACK carries 0x80: its
 *  `ErrorWithSubackPacket`, with the SUBACK on it. A lost link gives an error
 *  without a packet. */
function subackFailure(): Error {
  return Object.assign(new Error("Subscribe error: Unspecified error"), {
    packet: { cmd: "suback", granted: [0x80] },
  });
}

/** Hands out {@link FakeMqttClient}s and keeps them, so a test can play the
 *  broker and read what reached it. Like `mqtt.connect`, it throws "Missing
 *  protocol" on a URL without one, and "Invalid URL" on one no WebSocket can be
 *  opened to (a space, an unclosed bracket, an impossible port).
 *
 *  A client opened while another one to the same broker is up is a link
 *  renewed for its will: it is kept apart from the connections. */
class StubMqttClientFactory implements MqttClientFactory {
  /** Every connection opened, oldest first; no renewed link. */
  readonly opened: FakeMqttClient[] = [];
  /** Every link opened to renew another one's will, oldest first. */
  readonly renewals: FakeMqttClient[] = [];
  /** Every will link opened, oldest first. */
  readonly willLinks: FakeMqttClient[] = [];
  private readonly all: FakeMqttClient[] = [];
  create(conn: BrokerConn, will: Will | undefined, purpose: ClientPurpose): MqttClientLike {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(conn.url)) throw new Error("Missing protocol");
    if (!URL.canParse(conn.url)) throw new Error("Invalid URL");
    if (purpose === "will") {
      const client = new FakeMqttClient(conn, will, false, purpose);
      this.willLinks.push(client);
      return client;
    }
    const renewal = this.all.some((other) => other.conn.id === conn.id && other.connected && !other.ended);
    const client = new FakeMqttClient(conn, will, renewal);
    this.all.push(client);
    (renewal ? this.renewals : this.opened).push(client);
    return client;
  }
  /** The newest link to `brokerId` that is in use, or will be once it
   *  connects: a renewed link counts once it connected. */
  client(brokerId: string): FakeMqttClient {
    const client = this.all.findLast(
      (opened) => opened.conn.id === brokerId && (!opened.renewal || opened.everConnected),
    );
    if (!client) throw new Error(`no connection was opened to ${brokerId}`);
    return client;
  }
  /** The link being opened to renew `brokerId`'s will. */
  renewal(brokerId: string): FakeMqttClient {
    const client = this.renewals.findLast(
      (opened) => opened.conn.id === brokerId && !opened.everConnected && !opened.ended,
    );
    if (!client) throw new Error(`no link is being renewed for ${brokerId}`);
    return client;
  }
}

type Inject = { source: string; handle: string; value: unknown };
type Delivery = { nodeId: string | undefined; topic: string; text: string };

/** A TS twin of core's `figma_announce_actions`, injected so the Figma seam runs
 *  without the wasm runtime (the generated module belongs to the runtime
 *  vertical). The real policy is unit-tested in Rust (`subscriptions.rs`); here
 *  the stub lets the performer's publish plumbing be asserted. Like core: a
 *  Bridge ID that left its broker says `disconnected` there, one that arrived
 *  on its broker says `connected` and asks for the variables there, every
 *  departure comes before every arrival, and each group is in uid order. The
 *  twin is held to the real policy by the table both are run over
 *  (`FIGMA_ANNOUNCE_CASES`). */
const figmaAnnounceStub: FigmaAnnounce = (prev, next) => {
  // Core's maps are ordered by uid; an object's keys are not.
  const byUid = (uids: Record<string, string>) =>
    Object.entries(uids).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const actions: FigmaPublish[] = [];
  for (const [uid, brokerId] of byUid(prev)) {
    if (next[uid] !== brokerId) {
      actions.push({ brokerId, topic: `microflow/${uid}/app/status`, payload: "disconnected", retain: true });
    }
  }
  for (const [uid, brokerId] of byUid(next)) {
    if (prev[uid] === brokerId) continue;
    actions.push({ brokerId, topic: `microflow/${uid}/app/status`, payload: "connected", retain: true });
    actions.push({ brokerId, topic: `microflow/${uid}/app/variables/request`, payload: "", retain: false });
  }
  return actions;
};

describe("the announce policy twin", () => {
  // The same table the compiled policy is run over
  // (`runtime/figma-announce.wasm.test.ts`).
  for (const { name, prev, next, publishes } of FIGMA_ANNOUNCE_CASES) {
    test(name, () => {
      expect(figmaAnnounceStub(prev, next)).toEqual(publishes);
    });
  }
});

/** Build a performer over fakes. `brokers` is the broker config the performer
 *  resolves from, for a test to edit; `injects`, `delivered` and `feed` capture
 *  what re-entered the runtime and what reached the UI feed. Its waits run on
 *  `timers`, virtual time. */
function setup() {
  const injects: Inject[] = [];
  const delivered: Delivery[] = [];
  const feed: Delivery[] = [];
  const factory = new StubMqttClientFactory();
  const timers = new FakeTimers();
  const brokers = new Map<string, BrokerConn>([["b1", { id: "b1", url: "wss://broker.test" }]]);
  const text = (payload: Uint8Array) => new TextDecoder().decode(payload);
  const cloud: CloudDeps = {
    resolveLlmProvider: () => ({ baseUrl: "http://llm.test", apiKey: "" }),
    resolveBroker: (id) => brokers.get(id),
    onMqttMessage: (topic, payload, nodeId) => feed.push({ nodeId, topic, text: text(payload) }),
    timers,
  };
  const performer = new CloudPerformer(
    cloud,
    (source, handle, value) => injects.push({ source, handle, value }),
    (nodeId, topic, payload) => delivered.push({ nodeId, topic, text: text(payload) }),
    figmaAnnounceStub,
    factory,
  );
  return { performer, factory, timers, brokers, injects, delivered, feed };
}

const llmRequest = (source: string, prompt: string): ActiveLlmReq => ({
  source,
  kind: "llmGenerate",
  providerId: "p",
  model: "m",
  system: null,
  prompt,
});
type ActiveLlmReq = Extract<Parameters<CloudPerformer["perform"]>[0], { kind: "llmGenerate" }>;

const mqttPublish = (topic: string, text: string, retain = false): ActiveMqttReq => ({
  source: "mqtt",
  kind: "mqttPublish",
  brokerId: "b1",
  topic,
  payload: [...new TextEncoder().encode(text)],
  retain,
});
type ActiveMqttReq = Extract<Parameters<CloudPerformer["perform"]>[0], { kind: "mqttPublish" }>;

describe("CloudPerformer (ADR-0009 cloud seam)", () => {
  test("(a) llmGenerate streams into value, then re-enters thinking/value/done", async () => {
    stubFetch((async () => streamResponse(["hi", " back"])) as typeof fetch);
    const { performer, injects } = setup();

    performer.perform(llmRequest("llm", "hello"));
    await waitFor(() => injects.some((i) => i.handle === "done"));

    // Each delta re-injects the whole answer so far on `value` (every inject
    // overwrites the last, so a Monitor fills in as the model writes), and only
    // then does the terminal trio land — the same handles both hosts inject on.
    expect(injects).toEqual([
      { source: "llm", handle: "value", value: "hi" },
      { source: "llm", handle: "value", value: "hi back" },
      { source: "llm", handle: "thinking", value: false },
      { source: "llm", handle: "value", value: "hi back" },
      { source: "llm", handle: "done", value: true },
    ]);
  });

  test("(b) a second llmGenerate for the same source supersedes the first (latest-wins)", async () => {
    let firstAborted = false;
    let releaseSecond: (() => void) | undefined;
    let call = 0;
    stubFetch(((_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      const signal = init?.signal ?? undefined;
      if (call === 1) {
        // Hang until aborted, then reject the way a real aborted fetch does.
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            firstAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return new Promise<Response>((resolve) => {
        releaseSecond = () => resolve(streamResponse(["second-answer"]));
      });
    }) as unknown as typeof fetch);

    const { performer, injects } = setup();

    performer.perform(llmRequest("llm", "first"));
    await waitFor(() => call === 1);
    performer.perform(llmRequest("llm", "second")); // supersedes — must abort the first

    await waitFor(() => firstAborted);
    expect(firstAborted).toBe(true);

    await waitFor(() => releaseSecond !== undefined);
    releaseSecond?.();
    await waitFor(() => injects.some((i) => i.handle === "done"));

    // Only the second generation re-enters; the aborted first drops silently —
    // no `error` inject, because a superseded result would route nowhere.
    expect(injects.filter((i) => i.handle === "error")).toEqual([]);
    expect(injects.at(-2)).toEqual({
      source: "llm",
      handle: "value",
      value: "second-answer",
    });
    expect(injects.at(-1)).toEqual({ source: "llm", handle: "done", value: true });
  });

  test("a publish on a topic with a wildcard is not sent, and opens no connection", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { performer, factory } = setup();

      performer.perform(mqttPublish("lights/+", "on"));
      performer.perform(mqttPublish("lights/#", "on"));
      performer.perform(mqttPublish("lights/+", "off"));

      expect(factory.opened).toEqual([]);
      expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
        "[cloud-performer] 'lights/+' is not a topic a message can be published on (it holds a wildcard or is empty); publishes to it are dropped",
        "[cloud-performer] 'lights/#' is not a topic a message can be published on (it holds a wildcard or is empty); publishes to it are dropped",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("(c) an mqttPublish request reaches the broker", () => {
    const { performer, factory } = setup();

    performer.perform(mqttPublish("lights/kitchen", "on", true));
    const client = factory.client("b1");
    client.connect();

    expect(client.wire).toEqual([published("lights/kitchen", "on", true)]);
  });
});

// A design variable node on Bridge ID `uid-1`, a plain Mqtt node, and the
// handshake Studio publishes for the Bridge ID (retained status, then a
// variables request).
const VARIABLE = "microflow/uid-1/figma/variable/1-2";
const SENSOR = "sensors/temperature";
const variableSub = (nodeId = "fig"): ActiveSub => ({
  brokerId: "b1",
  topic: VARIABLE,
  nodeId,
  kind: "topicAware",
});
const sensorSub = (nodeId = "mqtt"): ActiveSub => ({
  brokerId: "b1",
  topic: SENSOR,
  nodeId,
  kind: "plain",
});
// A second plain topic on the same broker, for a test that needs the broker to
// stay in use while another topic goes.
const DOOR = "doors/front";
const doorSub = (): ActiveSub => ({ brokerId: "b1", topic: DOOR, nodeId: "door", kind: "plain" });
const STUDIO_CONNECTED = published("microflow/uid-1/app/status", "connected", true);
const STUDIO_DISCONNECTED = published("microflow/uid-1/app/status", "disconnected", true);
const VARIABLES_REQUEST = published("microflow/uid-1/app/variables/request", "");

describe("CloudPerformer subscriptions", () => {
  test("a new wiring is subscribed once its broker connects, and a removed one unsubscribed", () => {
    const { performer, factory } = setup();

    performer.reconcile([sensorSub(), doorSub()]);
    const client = factory.client("b1");
    expect(client.wire).toEqual([]);

    client.connect();
    expect(client.wire).toEqual([subscribed(SENSOR), subscribed(DOOR)]);

    performer.reconcile([doorSub()]);
    expect(client.wire.slice(2)).toEqual([unsubscribed(SENSOR)]);

    // The last one: the flow has no use for the connection any more.
    performer.reconcile([]);
    expect(client.wire.slice(3)).toEqual([unsubscribed(DOOR), DISCONNECT]);
  });

  test("a new Bridge ID is subscribed, then announced", () => {
    const { performer, factory } = setup();

    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();

    expect(client.wire).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
  });

  test("a vanished Bridge ID is unsubscribed, then announced disconnected", () => {
    const { performer, factory } = setup();
    performer.reconcile([variableSub(), sensorSub()]);
    const client = factory.client("b1");
    client.connect();
    const before = client.wire.length;

    performer.reconcile([sensorSub()]);

    expect(client.wire.slice(before)).toEqual([unsubscribed(VARIABLE), STUDIO_DISCONNECTED]);
    expect(client.ended).toBe(false);
  });

  test("a vanished Bridge ID that was all the flow used its broker for is announced disconnected, then the connection closed", () => {
    const { performer, factory } = setup();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();

    performer.reconcile([]);

    expect(client.wire.slice(3)).toEqual([
      unsubscribed(VARIABLE),
      STUDIO_DISCONNECTED,
      DISCONNECT,
    ]);
  });

  test("an unchanged wiring touches no broker", () => {
    const { performer, factory } = setup();
    performer.reconcile([sensorSub(), variableSub()]);
    const client = factory.client("b1");
    client.connect();
    const before = [...client.wire];

    // What a node move produces: the same reconciled set again.
    performer.reconcile([sensorSub(), variableSub()]);

    expect(client.wire).toEqual(before);
    expect(factory.opened).toHaveLength(1);
  });

  test("a message reaches the node that owns its topic, and no node once the topic is removed", () => {
    const { performer, factory, delivered, feed } = setup();
    performer.reconcile([sensorSub("first")]);
    const client = factory.client("b1");
    client.connect();

    client.deliver(SENSOR, "21");
    expect(delivered).toEqual([{ nodeId: "first", topic: SENSOR, text: "21" }]);
    expect(feed).toEqual([{ nodeId: "first", topic: SENSOR, text: "21" }]);

    // Another node takes the topic over: the broker already holds it.
    performer.reconcile([sensorSub("second")]);
    client.deliver(SENSOR, "22");
    expect(delivered.at(-1)).toEqual({ nodeId: "second", topic: SENSOR, text: "22" });
    expect(client.wire).toEqual([subscribed(SENSOR)]);

    // Even a message the broker sends after the unsubscribe goes nowhere.
    performer.reconcile([]);
    client.deliver(SENSOR, "23");
    expect(delivered).toHaveLength(2);
  });

  test("a display-only message reaches the UI feed without a node", () => {
    const { performer, factory, delivered, feed } = setup();
    const topic = "microflow/uid-1/figma/variables";
    performer.reconcile([{ brokerId: "b1", topic, nodeId: "fig", kind: "displayEcho" }]);
    const client = factory.client("b1");
    client.connect();

    client.deliver(topic, "{}");

    expect(delivered).toEqual([]);
    expect(feed).toEqual([{ nodeId: undefined, topic, text: "{}" }]);
  });

  test("a subscription with no broker configured is made once the broker is configured", () => {
    const { performer, factory, brokers } = setup();
    brokers.delete("b1");

    performer.reconcile([variableSub()]);
    expect(factory.opened).toEqual([]);

    brokers.set("b1", { id: "b1", url: "wss://broker.test" });
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();

    expect(client.wire).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
  });

  test("a publish to a broker configured since the last reconcile makes its subscriptions too", () => {
    const { performer, factory, brokers } = setup();
    brokers.delete("b1");
    performer.reconcile([sensorSub()]);

    brokers.set("b1", { id: "b1", url: "wss://broker.test" });
    performer.perform(mqttPublish("lights/kitchen", "on"));
    const client = factory.client("b1");
    client.connect();

    expect(client.wire).toEqual([published("lights/kitchen", "on"), subscribed(SENSOR)]);
  });

  test("a half-typed broker URL is not connected to, and is subscribed once it is complete", () => {
    for (const halfTyped of ["", "broker.example.com", "wss:/", "mqtt://broker.example.com"]) {
      const { performer, factory, brokers } = setup();
      brokers.set("b1", { id: "b1", url: halfTyped });

      performer.reconcile([sensorSub()]);
      performer.perform(mqttPublish("lights/kitchen", "on"));
      expect(factory.opened).toEqual([]);

      brokers.set("b1", { id: "b1", url: "wss://broker.example.com" });
      performer.reconcile([sensorSub()]);
      const client = factory.client("b1");
      client.connect();

      expect(client.conn.url).toBe("wss://broker.example.com");
      expect(client.wire).toEqual([subscribed(SENSOR)]);
    }
  });

  test("a subscribe the broker refused is not live and is retried", () => {
    const { performer, factory, delivered } = setup();
    performer.reconcile([sensorSub()]);
    const client = factory.client("b1");
    client.refused.add(SENSOR);
    client.connect();
    expect(client.wire).toEqual([subscribed(SENSOR)]);

    // The broker would take it now; the next reconcile asks again.
    client.refused.clear();
    performer.reconcile([sensorSub()]);

    expect(client.wire).toEqual([subscribed(SENSOR), subscribed(SENSOR)]);
    client.deliver(SENSOR, "21");
    expect(delivered).toEqual([{ nodeId: "mqtt", topic: SENSOR, text: "21" }]);
  });

  test("a filter with a wildcard where the Bridge ID goes is subscribed, and names no Bridge ID to announce", () => {
    const { performer, factory } = setup();
    const wildcard = "microflow/+/figma/status";

    performer.reconcile([{ brokerId: "b1", topic: wildcard, nodeId: "mqtt", kind: "plain" }]);
    const client = factory.client("b1");
    client.connect();

    expect(client.wire).toEqual([subscribed(wildcard)]);
  });

  test("a Bridge ID is announced only once its subscription is in place", () => {
    const { performer, factory } = setup();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.deferAcks = true;
    client.connect();
    expect(client.wire).toEqual([subscribed(VARIABLE)]);

    client.ack();

    expect(client.wire).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
  });

  test("a Bridge ID whose subscription the broker refused is announced neither connected nor disconnected", () => {
    const { performer, factory } = setup();
    performer.reconcile([sensorSub(), variableSub()]);
    const client = factory.client("b1");
    client.refused.add(VARIABLE);
    client.connect();
    expect(client.wire).toEqual([subscribed(SENSOR), subscribed(VARIABLE)]);

    performer.reconcile([sensorSub()]);
    expect(client.wire).toEqual([subscribed(SENSOR), subscribed(VARIABLE)]);

    // Refused no longer: the retry subscribes it and only then announces.
    client.refused.clear();
    performer.reconcile([sensorSub(), variableSub()]);
    expect(client.wire.slice(2)).toEqual([
      subscribed(VARIABLE),
      STUDIO_CONNECTED,
      VARIABLES_REQUEST,
    ]);
  });

  test("a broker that reconnects gets its subscriptions again, and is told again that Studio is there", () => {
    const { performer, factory, delivered } = setup();
    performer.reconcile([sensorSub(), variableSub()]);
    const client = factory.client("b1");
    client.connect();
    const before = client.wire.length;

    // The link was lost without a goodbye, so the broker published the will;
    // and what the plugins sent meanwhile never reached Studio.
    client.drop();
    client.connect();

    expect(client.wire.slice(before)).toEqual([
      subscribed(SENSOR),
      subscribed(VARIABLE),
      STUDIO_CONNECTED,
      VARIABLES_REQUEST,
    ]);
    client.deliver(SENSOR, "21");
    expect(delivered).toEqual([{ nodeId: "mqtt", topic: SENSOR, text: "21" }]);
  });

  test("a Bridge ID is told again only once the new link holds its topic", () => {
    const { performer, factory } = setup();
    performer.reconcile([sensorSub(), variableSub()]);
    const client = factory.client("b1");
    client.connect();
    const before = client.wire.length;

    client.drop();
    client.deferAcks = true;
    client.connect();
    expect(client.wire.slice(before)).toEqual([subscribed(SENSOR), subscribed(VARIABLE)]);

    client.ack();
    expect(client.wire.slice(before + 2)).toEqual([STUDIO_CONNECTED, VARIABLES_REQUEST]);
    // Said once for the link, whatever is reconciled after.
    performer.reconcile([sensorSub(), variableSub()]);
    expect(client.wire).toHaveLength(before + 4);
  });

  test("a Bridge ID announced while its broker's link is down is said once, when the link is back", () => {
    const { performer, factory, brokers } = setup();
    brokers.set("b2", { id: "b2", url: "wss://second.test" });
    const onSecond: ActiveSub = {
      brokerId: "b2",
      topic: "microflow/uid-1/penpot/variable/9",
      nodeId: "pen",
      kind: "topicAware",
    };
    performer.reconcile([variableSub(), onSecond]);
    const first = factory.client("b1");
    const second = factory.client("b2");
    first.connect();
    second.connect();
    const before = second.wire.length;

    // The link to the second broker is down when the Bridge ID moves there.
    second.drop();
    performer.reconcile([onSecond]);
    expect(second.wire).toHaveLength(before);

    // What the client stored goes out on the new link, and is not said again
    // when the new link holds the topic.
    second.connect();
    expect(second.wire.slice(before)).toEqual([
      published("microflow/uid-1/app/status", "connected", true),
      VARIABLES_REQUEST,
      subscribed(onSecond.topic),
    ]);
  });

  test("a subscribe whose answer was lost with the link is made again on reconnect", () => {
    const { performer, factory } = setup();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.deferAcks = true;
    client.connect();
    client.drop();
    expect(client.wire).toEqual([subscribed(VARIABLE)]);

    client.deferAcks = false;
    client.connect();

    expect(client.wire).toEqual([
      subscribed(VARIABLE),
      subscribed(VARIABLE),
      STUDIO_CONNECTED,
      VARIABLES_REQUEST,
    ]);
  });

  test("a subscription the broker refuses after a reconnect is no longer live, and is retried", () => {
    const { performer, factory } = setup();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();
    const before = client.wire.length;

    client.drop();
    client.refused.add(VARIABLE);
    client.connect();
    expect(client.wire.slice(before)).toEqual([subscribed(VARIABLE), STUDIO_DISCONNECTED]);

    client.refused.clear();
    performer.reconcile([variableSub()]);
    expect(client.wire.slice(before + 2)).toEqual([
      subscribed(VARIABLE),
      STUDIO_CONNECTED,
      VARIABLES_REQUEST,
    ]);
  });

  test("a broker whose settings changed is reconnected and gets its subscriptions again", () => {
    const { performer, factory, brokers } = setup();
    performer.reconcile([variableSub()]);
    const old = factory.client("b1");
    old.connect();
    const before = [...old.wire];

    brokers.set("b1", { id: "b1", url: "wss://other.test", username: "studio" });
    performer.reconcile([variableSub()]);

    // The old broker is told Studio left before the connection closes, so it
    // does not keep a retained `connected` for a Studio that is gone.
    expect(old.ended).toBe(true);
    expect(old.wire).toEqual([...before, STUDIO_DISCONNECTED, DISCONNECT]);
    const client = factory.client("b1");
    expect(client.conn).toEqual({ id: "b1", url: "wss://other.test", username: "studio" });
    client.connect();
    expect(client.wire).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
  });

  test("a publish after a settings change goes to the new connection, with the subscriptions", () => {
    const { performer, factory, brokers } = setup();
    performer.reconcile([sensorSub()]);
    factory.client("b1").connect();

    brokers.set("b1", { id: "b1", url: "wss://other.test" });
    performer.perform(mqttPublish("lights/kitchen", "on"));

    const client = factory.client("b1");
    expect(client.conn.url).toBe("wss://other.test");
    client.connect();
    expect(client.wire).toEqual([published("lights/kitchen", "on"), subscribed(SENSOR)]);
  });

  test("a broker removed from the config is told Studio left, and subscribed again when it is back", () => {
    const { performer, factory, brokers } = setup();
    performer.reconcile([variableSub()]);
    const old = factory.client("b1");
    old.connect();

    brokers.delete("b1");
    performer.reconcile([variableSub()]);
    expect(old.ended).toBe(true);
    expect(old.wire.slice(3)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
    expect(factory.opened).toHaveLength(1);

    brokers.set("b1", { id: "b1", url: "wss://broker.test" });
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();
    expect(client.wire).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
  });

  test("a connection whose link is down is replaced without a goodbye", () => {
    const { performer, factory, brokers } = setup();
    performer.reconcile([variableSub()]);
    const old = factory.client("b1");
    old.connect();
    const before = [...old.wire];
    old.drop();
    performer.perform(mqttPublish("lights/kitchen", "on"));

    brokers.set("b1", { id: "b1", url: "wss://other.test" });
    performer.reconcile([variableSub()]);

    // Nothing is left behind for the old broker to receive if its link returns.
    expect(old.ended).toBe(true);
    old.connect();
    expect(old.wire).toEqual(before);

    // The Bridge ID is announced on the new connection like any new one.
    const client = factory.client("b1");
    client.connect();
    expect(client.wire).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
  });

  test("an answer that arrives on a replaced connection says nothing about the new one", () => {
    const { performer, factory, brokers } = setup();
    performer.reconcile([variableSub()]);
    const old = factory.client("b1");
    old.deferAcks = true;
    old.connect();

    brokers.set("b1", { id: "b1", url: "wss://other.test" });
    performer.reconcile([variableSub()]);
    old.ack();

    const client = factory.client("b1");
    client.connect();
    expect(client.wire).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
  });

  test("a broker URL that cannot be opened throws nothing, and is connected to once it can be", () => {
    for (const unopenable of ["ws://a b", "ws://[", "ws://host:99999"]) {
      const { performer, factory, brokers } = setup();
      brokers.set("b1", { id: "b1", url: unopenable });

      expect(() => performer.reconcile([sensorSub()])).not.toThrow();
      expect(() => performer.perform(mqttPublish("lights/kitchen", "on"))).not.toThrow();
      expect(factory.opened).toEqual([]);

      brokers.set("b1", { id: "b1", url: "ws://host:9001" });
      performer.reconcile([sensorSub()]);
      const client = factory.client("b1");
      client.connect();
      expect(client.wire).toEqual([subscribed(SENSOR)]);
    }
  });

  test("a broker in use whose URL is edited into one that cannot be opened throws nothing", () => {
    const { performer, factory, brokers } = setup();
    performer.reconcile([sensorSub()]);
    const old = factory.client("b1");
    old.connect();

    // What settles when the typing pauses a keystroke into an edit.
    brokers.set("b1", { id: "b1", url: "wss://broker.test:99999" });
    expect(() => performer.perform(mqttPublish("lights/kitchen", "on"))).not.toThrow();
    expect(() => performer.reconcile([sensorSub()])).not.toThrow();
    expect(old.ended).toBe(true);
    expect(factory.opened).toHaveLength(1);

    brokers.set("b1", { id: "b1", url: "wss://broker.test:9999" });
    performer.perform(mqttPublish("lights/kitchen", "on"));
    const client = factory.client("b1");
    client.connect();
    expect(client.wire).toEqual([published("lights/kitchen", "on"), subscribed(SENSOR)]);
  });

  test("a topic removed while its broker is offline is not subscribed when the broker is back", () => {
    const { performer, factory, delivered } = setup();
    performer.reconcile([sensorSub(), variableSub()]);
    const client = factory.client("b1");
    client.connect();
    const before = client.wire.length;

    client.drop();
    performer.reconcile([variableSub()]);
    client.connect();

    expect(client.wire.slice(before)).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
    expect([...client.held]).toEqual([VARIABLE]);
    client.deliver(SENSOR, "21");
    expect(delivered).toEqual([]);
  });

  test("a topic removed before the broker answered its subscribe does not go live", () => {
    const { performer, factory } = setup();
    performer.reconcile([sensorSub(), variableSub()]);
    const client = factory.client("b1");
    client.deferAcks = true;
    client.connect();

    performer.reconcile([sensorSub()]);
    client.ack();

    expect(client.wire).toEqual([
      subscribed(SENSOR),
      subscribed(VARIABLE),
      unsubscribed(VARIABLE),
    ]);
    expect([...client.held]).toEqual([SENSOR]);

    // Not live: wanted again, it is asked of the broker again.
    client.deferAcks = false;
    performer.reconcile([sensorSub(), variableSub()]);
    expect(client.wire.slice(3)).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
  });

  test("a topic removed and wanted again is subscribed again", () => {
    const { performer, factory } = setup();
    performer.reconcile([doorSub(), sensorSub()]);
    const client = factory.client("b1");
    client.connect();

    performer.reconcile([doorSub()]);
    performer.reconcile([doorSub(), sensorSub()]);

    expect(client.wire.slice(1)).toEqual([
      subscribed(SENSOR),
      unsubscribed(SENSOR),
      subscribed(SENSOR),
    ]);
  });

  test("a topic that was all the flow used its broker for, removed and wanted again, is subscribed on a new connection", () => {
    const { performer, factory } = setup();
    performer.reconcile([sensorSub()]);
    const old = factory.client("b1");
    old.connect();

    performer.reconcile([]);
    performer.reconcile([sensorSub()]);

    expect(old.wire).toEqual([subscribed(SENSOR), unsubscribed(SENSOR), DISCONNECT]);
    const client = factory.client("b1");
    expect(client).not.toBe(old);
    client.connect();
    expect(client.wire).toEqual([subscribed(SENSOR)]);
  });

  test("the answer to a subscribe that was since removed and asked again is ignored", () => {
    const { performer, factory } = setup();
    performer.reconcile([sensorSub(), variableSub()]);
    const client = factory.client("b1");
    client.deferAcks = true;
    client.connect();

    // The first SUBSCRIBE is accepted, the second refused; both answers are out.
    performer.reconcile([sensorSub()]);
    client.refused.add(VARIABLE);
    performer.reconcile([sensorSub(), variableSub()]);
    client.ack();

    expect(client.wire).toEqual([
      subscribed(SENSOR),
      subscribed(VARIABLE),
      unsubscribed(VARIABLE),
      subscribed(VARIABLE),
    ]);
  });

  test("a subscribe made between the broker's CONNACK and the connect event is sent once", () => {
    const { performer, factory } = setup();
    performer.reconcile([sensorSub()]);
    const client = factory.client("b1");

    // No answer can arrive in that moment: the event comes first.
    client.deferAcks = true;
    client.accept();
    performer.reconcile([sensorSub(), variableSub()]);
    client.connect();
    client.ack();

    expect(client.wire).toEqual([
      subscribed(SENSOR),
      subscribed(VARIABLE),
      STUDIO_CONNECTED,
      VARIABLES_REQUEST,
    ]);
  });

  test("a link lost while a held topic is subscribed again is not a refusal", () => {
    const { performer, factory } = setup();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();
    const before = client.wire.length;

    // The link comes back and is lost again before the broker answers.
    client.drop();
    client.deferAcks = true;
    client.connect();
    client.drop();
    client.deferAcks = false;
    client.connect();

    // Still live throughout: no `disconnected`. The link that held the topic
    // again is told Studio is there, once.
    expect(client.wire.slice(before)).toEqual([
      subscribed(VARIABLE),
      subscribed(VARIABLE),
      STUDIO_CONNECTED,
      VARIABLES_REQUEST,
    ]);
  });

  test("a Bridge ID on two brokers is announced on the one that held it first, and leaves from there", () => {
    const { performer, factory, brokers } = setup();
    brokers.set("b2", { id: "b2", url: "wss://second.test" });
    const onSecond: ActiveSub = {
      brokerId: "b2",
      topic: "microflow/uid-1/penpot/variable/9",
      nodeId: "pen",
      kind: "topicAware",
    };
    performer.reconcile([variableSub(), onSecond]);
    const first = factory.client("b1");
    const second = factory.client("b2");

    second.connect();
    first.connect();
    expect(second.wire).toEqual([subscribed(onSecond.topic), STUDIO_CONNECTED, VARIABLES_REQUEST]);
    expect(first.wire).toEqual([subscribed(VARIABLE)]);

    // Another of its topics takes the place of the one on the second broker:
    // the Bridge ID is still there, and says nothing.
    const alsoOnSecond: ActiveSub = { ...onSecond, topic: "microflow/uid-1/penpot/variable/10" };
    performer.reconcile([variableSub(), alsoOnSecond]);
    expect(second.wire.slice(3)).toEqual([
      unsubscribed(onSecond.topic),
      subscribed(alsoOnSecond.topic),
    ]);

    // Neither broker is used for anything else: both connections close.
    performer.reconcile([]);
    expect(second.wire.slice(5)).toEqual([
      unsubscribed(alsoOnSecond.topic),
      STUDIO_DISCONNECTED,
      DISCONNECT,
    ]);
    expect(first.wire.slice(1)).toEqual([unsubscribed(VARIABLE), DISCONNECT]);
  });

  test("a Bridge ID on two brokers moves to the other one when the broker it was announced on lets go of it", () => {
    const { performer, factory, brokers } = setup();
    brokers.set("b2", { id: "b2", url: "wss://second.test" });
    const onSecond: ActiveSub = {
      brokerId: "b2",
      topic: "microflow/uid-1/penpot/variable/9",
      nodeId: "pen",
      kind: "topicAware",
    };
    performer.reconcile([variableSub(), onSecond]);
    const first = factory.client("b1");
    const second = factory.client("b2");
    second.connect();
    first.connect();

    // The node on the second broker goes. The first broker holds the Bridge
    // ID already, and is told now; the second is told and let go of.
    performer.reconcile([variableSub()]);
    expect(second.wire.slice(3)).toEqual([
      unsubscribed(onSecond.topic),
      STUDIO_DISCONNECTED,
      DISCONNECT,
    ]);
    expect(first.wire.slice(1)).toEqual([STUDIO_CONNECTED, VARIABLES_REQUEST]);

    performer.reconcile([]);
    expect(first.wire.slice(3)).toEqual([unsubscribed(VARIABLE), STUDIO_DISCONNECTED, DISCONNECT]);
    expect(second.wire).toHaveLength(6);
  });

  test("a Bridge ID on two brokers moves to the other one when a publish finds the broker it was announced on removed", () => {
    const { performer, factory, brokers } = setup();
    brokers.set("b2", { id: "b2", url: "wss://second.test" });
    const onSecond: ActiveSub = {
      brokerId: "b2",
      topic: "microflow/uid-1/penpot/variable/9",
      nodeId: "pen",
      kind: "topicAware",
    };
    performer.reconcile([variableSub(), onSecond]);
    const first = factory.client("b1");
    const second = factory.client("b2");
    first.connect();
    second.connect();
    expect(second.wire).toEqual([subscribed(onSecond.topic)]);

    // No flow update follows: the publish is what closes the connection, and
    // what is left of the Bridge ID is announced there and then.
    brokers.delete("b1");
    performer.perform(mqttPublish("lights/kitchen", "on"));

    expect(first.wire.slice(3)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
    expect(second.wire.slice(1)).toEqual([STUDIO_CONNECTED, VARIABLES_REQUEST]);
  });

  test("a Bridge ID whose node moves to another broker leaves the old one and arrives on the new one, once", () => {
    const { performer, factory, brokers } = setup();
    brokers.set("b2", { id: "b2", url: "wss://second.test" });
    performer.reconcile([variableSub()]);
    const first = factory.client("b1");
    first.connect();

    // The old broker is told at once, and let go of; the new one is told when
    // it holds the topic.
    performer.reconcile([{ ...variableSub(), brokerId: "b2" }]);
    const second = factory.client("b2");
    expect(first.wire.slice(3)).toEqual([unsubscribed(VARIABLE), STUDIO_DISCONNECTED, DISCONNECT]);
    second.deferAcks = true;
    second.connect();
    expect(second.wire).toEqual([subscribed(VARIABLE)]);

    second.ack();
    expect(second.wire).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
    expect(first.wire).toHaveLength(6);
  });

  test("a Bridge ID whose node moves to a broker that answers at once is announced the same, once", () => {
    const { performer, factory, brokers } = setup();
    brokers.set("b2", { id: "b2", url: "wss://second.test" });
    const sensorOnSecond: ActiveSub = { ...sensorSub(), brokerId: "b2" };
    performer.reconcile([variableSub(), sensorOnSecond]);
    const first = factory.client("b1");
    const second = factory.client("b2");
    first.connect();
    second.connect();

    // The new broker's answer is in before the reconcile ends: leaving the old
    // broker and arriving on the new one are one change.
    performer.reconcile([{ ...variableSub(), brokerId: "b2" }, sensorOnSecond]);

    expect(first.wire.slice(3)).toEqual([unsubscribed(VARIABLE), STUDIO_DISCONNECTED, DISCONNECT]);
    expect(second.wire.slice(1)).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
  });

  test("a subscription that stays pending is warned about once, and again after it changed", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { performer, factory, brokers } = setup();
      brokers.delete("b1");
      performer.reconcile([sensorSub()]);
      performer.reconcile([sensorSub()]);
      performer.perform(mqttPublish("lights/kitchen", "on"));
      performer.perform(mqttPublish("lights/kitchen", "on"));
      // One for the subscription, one for the publishes.
      expect(warn).toHaveBeenCalledTimes(2);

      brokers.set("b1", { id: "b1", url: "wss://broker.test" });
      performer.reconcile([sensorSub()]);
      const client = factory.client("b1");
      client.refused.add(SENSOR);
      client.connect();
      performer.reconcile([sensorSub()]);
      performer.reconcile([sensorSub()]);
      // The same refusal, three times over.
      expect(client.wire).toEqual([subscribed(SENSOR), subscribed(SENSOR), subscribed(SENSOR)]);
      expect(warn).toHaveBeenCalledTimes(3);

      // Held, then refused after a reconnect: a new failure, said once more.
      client.refused.clear();
      performer.reconcile([sensorSub()]);
      client.drop();
      client.refused.add(SENSOR);
      client.connect();
      performer.reconcile([sensorSub()]);
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  test("dispose tells the plugins Studio left, for the Bridge IDs it announced", () => {
    const { performer, factory } = setup();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();

    performer.dispose();

    expect(client.wire.slice(3)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
    expect(client.ended).toBe(true);
  });

  test("dispose announces nothing for a Bridge ID that was never subscribed", () => {
    const { performer, factory } = setup();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.refused.add(VARIABLE);
    client.connect();

    performer.dispose();

    expect(client.wire).toEqual([subscribed(VARIABLE), DISCONNECT]);
  });
});

/** A performer that watches the broker settings, as the app's does. `edit`
 *  is a change to a broker's settled settings (or their removal), which tells
 *  whoever watches that this broker's changed. What is typed into the settings
 *  form has settled before it gets this far (`mqtt-broker.test.ts`). `timers`
 *  is the clock the performer's own waits run on. */
function watching(initial: BrokerConn[] = [{ id: "b1", url: "wss://broker.test" }]) {
  const delivered: Delivery[] = [];
  const factory = new StubMqttClientFactory();
  const timers = new FakeTimers();
  const settings = new Map<string, BrokerConn>(initial.map((conn) => [conn.id, conn] as const));
  const watchers = new Set<(brokerIds: readonly string[]) => void>();
  const cloud: CloudDeps = {
    resolveLlmProvider: () => undefined,
    resolveBroker: (id) => settings.get(id),
    watchBrokers: (onChange) => {
      watchers.add(onChange);
      return () => watchers.delete(onChange);
    },
    timers,
  };
  const performer = new CloudPerformer(
    cloud,
    () => {},
    (nodeId, topic, payload) =>
      delivered.push({ nodeId, topic, text: new TextDecoder().decode(payload) }),
    figmaAnnounceStub,
    factory,
  );
  const edit = (id: string, conn: Omit<BrokerConn, "id"> | undefined): void => {
    if (conn) settings.set(id, { id, ...conn });
    else settings.delete(id);
    for (const watcher of watchers) watcher([id]);
  };
  return { performer, factory, timers, settings, edit, delivered, watchers };
}

// The flow is not touched in any of these: after the first `reconcile` only
// the broker settings change, and the performer follows each change at once.
// The desktop host covers the same ground when its broker pool changes
// (`cloud_performer.rs`).
describe("CloudPerformer follows the broker settings", () => {
  test("a corrected password makes the pending subscription, with no flow update", () => {
    const { performer, factory, edit, delivered } = watching([
      { id: "b1", url: "wss://broker.test", username: "studio", password: "wrnog" },
    ]);
    performer.reconcile([sensorSub()]);
    // The broker refuses the connection: the link never comes up.
    const refusedLogin = factory.client("b1");
    expect(refusedLogin.wire).toEqual([]);

    edit("b1", { url: "wss://broker.test", username: "studio", password: "right" });

    expect(refusedLogin.ended).toBe(true);
    const client = factory.client("b1");
    expect(client.conn.password).toBe("right");
    client.connect();
    expect(client.wire).toEqual([subscribed(SENSOR)]);
    client.deliver(SENSOR, "21");
    expect(delivered).toEqual([{ nodeId: "mqtt", topic: SENSOR, text: "21" }]);
  });

  test("a broker the flow refers to is subscribed and announced on once it is added", () => {
    const { performer, factory, edit } = watching([]);
    performer.reconcile([variableSub()]);
    expect(factory.opened).toEqual([]);

    edit("b1", { url: "wss://broker.test" });

    const client = factory.client("b1");
    client.connect();
    expect(client.wire).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
  });

  test("a removed broker is told Studio left and its connection closed", () => {
    const { performer, factory, edit } = watching();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();

    edit("b1", undefined);

    expect(client.ended).toBe(true);
    expect(client.wire.slice(3)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
    expect(factory.opened).toHaveLength(1);
  });

  test("a removed broker that was only published to is closed too", () => {
    const { performer, factory, edit } = watching();
    performer.perform(mqttPublish("lights/kitchen", "on"));
    const client = factory.client("b1");
    client.connect();

    edit("b1", undefined);

    expect(client.ended).toBe(true);
    expect(client.wire).toEqual([published("lights/kitchen", "on"), DISCONNECT]);
  });

  test("a new URL replaces the connection of a broker in use: the old one is told Studio left, the new one asked for what the flow wants", () => {
    const { performer, factory, edit } = watching();
    performer.reconcile([variableSub()]);
    const old = factory.client("b1");
    old.connect();
    const before = [...old.wire];

    edit("b1", { url: "wss://other.test" });

    expect(old.wire).toEqual([...before, STUDIO_DISCONNECTED, DISCONNECT]);
    expect(factory.opened).toHaveLength(2);
    const client = factory.client("b1");
    expect(client.conn.url).toBe("wss://other.test");
    client.connect();
    expect(client.wire).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
  });

  test("an edit to a broker the flow does not use touches no broker", () => {
    const { performer, factory, edit } = watching([
      { id: "b1", url: "wss://broker.test" },
      { id: "b2", url: "wss://second.test" },
    ]);
    performer.reconcile([sensorSub(), variableSub()]);
    const client = factory.client("b1");
    client.connect();
    const before = [...client.wire];

    edit("b2", { url: "wss://second.test", password: "secret" });
    edit("b3", { url: "wss://third.test" });
    edit("b2", undefined);
    // A report that leaves the settings of the broker in use as they are.
    edit("b1", { url: "wss://broker.test" });

    expect(client.wire).toEqual(before);
    expect(client.ended).toBe(false);
    expect(factory.opened).toHaveLength(1);
  });

  test("a change to one broker touches no other broker the flow uses", () => {
    const { performer, factory, edit } = watching([
      { id: "b1", url: "wss://broker.test" },
      { id: "b2", url: "wss://second.test" },
    ]);
    const onSecond: ActiveSub = {
      brokerId: "b2",
      topic: "microflow/uid-2/figma/variable/3-4",
      nodeId: "fig-2",
      kind: "topicAware",
    };
    performer.reconcile([sensorSub(), onSecond]);
    factory.client("b1").connect();
    const second = factory.client("b2");
    second.connect();
    const before = [...second.wire];

    edit("b1", { url: "wss://other.test" });

    expect(factory.client("b1").conn.url).toBe("wss://other.test");
    expect(second.wire).toEqual(before);
    expect(second.ended).toBe(false);
    expect(factory.opened).toHaveLength(3);
  });

  test("brokers whose settings changed together are each followed", () => {
    const { performer, factory, settings, watchers } = watching([
      { id: "b1", url: "wss://broker.test" },
      { id: "b2", url: "wss://second.test" },
    ]);
    const onSecond: ActiveSub = { brokerId: "b2", topic: "doors/front", nodeId: "door", kind: "plain" };
    performer.reconcile([sensorSub(), onSecond]);
    factory.client("b1").connect();
    factory.client("b2").connect();

    // What was typed for two brokers settled in one change.
    settings.set("b1", { id: "b1", url: "wss://other.test" });
    settings.set("b2", { id: "b2", url: "wss://second-other.test" });
    for (const watcher of watchers) watcher(["b1", "b2"]);

    expect(factory.client("b1").conn.url).toBe("wss://other.test");
    expect(factory.client("b2").conn.url).toBe("wss://second-other.test");
    expect(factory.opened).toHaveLength(4);
  });

  test("writes to another broker cause no traffic while a broker the flow uses cannot be opened", () => {
    // `ws://host:99999` looks like a broker URL; `mqtt.connect` throws on it.
    const { performer, factory, edit } = watching([
      { id: "b1", url: "wss://broker.test" },
      { id: "b2", url: "ws://host:99999" },
    ]);
    const unopenable: ActiveSub = { brokerId: "b2", topic: "doors/front", nodeId: "door", kind: "plain" };
    performer.reconcile([sensorSub(), unopenable]);
    const client = factory.client("b1");
    client.refused.add(SENSOR);
    client.connect();
    expect(client.wire).toEqual([subscribed(SENSOR)]);

    for (let write = 0; write < 30; write++) edit("b3", { url: `wss://third.test/${write}` });

    expect(client.wire).toEqual([subscribed(SENSOR)]);
    expect(factory.opened).toHaveLength(1);
  });

  test("a broker that is only published to is connected to as it is set at the next publish", () => {
    // Whether or not a publish was dropped for it before it had a URL.
    for (const publishedBefore of [true, false]) {
      const { performer, factory, edit } = watching([{ id: "b1", url: "" }]);
      if (publishedBefore) performer.perform(mqttPublish("lights/kitchen", "on"));

      edit("b1", { url: "ws://host.test:9001" });

      // Nothing was kept for a broker that had no connection, and its new
      // settings alone open none: the flow has no use for it yet.
      expect(factory.opened).toEqual([]);

      performer.perform(mqttPublish("lights/kitchen", "off"));
      const client = factory.client("b1");
      expect(client.conn.url).toBe("ws://host.test:9001");
      client.connect();
      expect(client.wire).toEqual([published("lights/kitchen", "off")]);
      expect(factory.opened).toHaveLength(1);
    }
  });

  test("a disposed performer no longer watches the settings", () => {
    const { performer, factory, edit, watchers } = watching();
    performer.reconcile([sensorSub()]);
    factory.client("b1").connect();

    performer.dispose();
    edit("b1", { url: "wss://third.test" });

    expect(watchers.size).toBe(0);
    expect(factory.opened).toHaveLength(1);
  });
});

// A broker keeps the retained `connected` of a Bridge ID until it is told
// `disconnected`. Whatever makes a connection close, or a Bridge ID leave it,
// that broker is told first, and told once.
describe("CloudPerformer takes a Bridge ID back before its connection closes", () => {
  // The announce publishes on the connections as they are. Making one follow
  // its settings is not the announce's to do: it would close the connection
  // that was just announced on, or the one a `disconnected` is for.
  test("a Bridge ID is announced on the connection that holds its subscription, also when the broker's settings changed since", () => {
    const { performer, factory, brokers } = setup();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.deferAcks = true;
    client.connect();

    // Between the edit and the broker's answer nothing reaches for the broker:
    // no flow update, no publish.
    brokers.set("b1", { id: "b1", url: "wss://other.test" });
    client.ack();

    expect(client.wire).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
    expect(client.ended).toBe(false);
    expect(factory.opened).toHaveLength(1);

    // The next flow update makes the connection follow, and takes the Bridge
    // ID back on the old one first.
    performer.reconcile([variableSub()]);
    expect(client.wire.slice(3)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
    expect(factory.opened).toHaveLength(2);
  });

  test("a Bridge ID the broker lets go of is taken back on the connection it was announced on, also when the broker's settings changed since", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { performer, factory, brokers } = setup();
      performer.reconcile([variableSub()]);
      const client = factory.client("b1");
      client.connect();

      // The link returns and the broker refuses the topic it held.
      client.drop();
      client.refused.add(VARIABLE);
      brokers.set("b1", { id: "b1", url: "wss://other.test" });
      client.connect();

      expect(client.wire.slice(3)).toEqual([subscribed(VARIABLE), STUDIO_DISCONNECTED]);
      expect(client.ended).toBe(false);
      expect(factory.opened).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a node and its broker's settings removed in one flow update", () => {
    const { performer, factory, brokers } = setup();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();

    brokers.delete("b1");
    performer.reconcile([]);

    expect(client.wire.slice(3)).toEqual([unsubscribed(VARIABLE), STUDIO_DISCONNECTED, DISCONNECT]);
    expect(client.ended).toBe(true);
  });

  test("a node removed and its broker's settings changed in one flow update", () => {
    const { performer, factory, brokers } = setup();
    performer.reconcile([variableSub()]);
    const old = factory.client("b1");
    old.connect();

    brokers.set("b1", { id: "b1", url: "wss://other.test" });
    performer.reconcile([]);

    expect(old.wire.slice(3)).toEqual([unsubscribed(VARIABLE), STUDIO_DISCONNECTED, DISCONNECT]);
    // The flow uses nothing on that broker now: its new URL is not connected to.
    expect(factory.opened).toHaveLength(1);
  });

  test("a node removed while its broker stays in use says disconnected once, and nothing more when the connection closes", () => {
    for (const close of ["dispose", "broker removed"] as const) {
      const { performer, factory, brokers } = setup();
      performer.reconcile([variableSub(), sensorSub()]);
      const client = factory.client("b1");
      client.connect();
      const before = client.wire.length;

      performer.reconcile([sensorSub()]);
      expect(client.wire.slice(before)).toEqual([unsubscribed(VARIABLE), STUDIO_DISCONNECTED]);
      expect(client.ended).toBe(false);

      if (close === "dispose") performer.dispose();
      else {
        brokers.delete("b1");
        performer.perform(mqttPublish("lights/kitchen", "on"));
      }
      expect(client.wire.slice(before + 2)).toEqual([DISCONNECT]);
    }
  });

  test("a broker's settings removed while the node stays: told on close, announced nowhere, and again when the broker is back", () => {
    const { performer, factory, brokers } = setup();
    performer.reconcile([variableSub()]);
    const old = factory.client("b1");
    old.connect();

    brokers.delete("b1");
    performer.reconcile([variableSub()]);
    expect(old.wire.slice(3)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);

    // Announced nowhere now: the same flow again, and the node going and
    // coming back, tell nobody anything.
    performer.reconcile([variableSub()]);
    performer.reconcile([]);
    performer.reconcile([variableSub()]);
    expect(old.wire).toHaveLength(5);
    expect(factory.opened).toHaveLength(1);

    brokers.set("b1", { id: "b1", url: "wss://broker.test" });
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();
    expect(client.wire).toEqual([subscribed(VARIABLE), STUDIO_CONNECTED, VARIABLES_REQUEST]);
  });

  test("a broker removed and then its node: told once, on the connection it had", () => {
    const { performer, factory, edit } = watching();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();

    edit("b1", undefined);
    expect(client.wire.slice(3)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);

    performer.reconcile([]);
    expect(client.wire).toHaveLength(5);
    expect(factory.opened).toHaveLength(1);
  });

  test("a node removed after its broker's URL changed: the new connection closes without having been announced on", () => {
    const { performer, factory, edit } = watching();
    performer.reconcile([variableSub()]);
    const old = factory.client("b1");
    old.connect();

    edit("b1", { url: "wss://other.test" });
    expect(old.wire.slice(3)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
    const next = factory.client("b1");
    expect(next.conn.url).toBe("wss://other.test");

    // Before the broker at the new URL has answered.
    performer.reconcile([]);

    expect(next.ended).toBe(true);
    expect(next.wire).toEqual([]);
    expect(old.wire).toHaveLength(5);
    expect(factory.opened).toHaveLength(2);
  });

  test("a node that stays while another one goes after their broker's URL changed is on the new connection, where nothing was announced", () => {
    const { performer, factory, edit } = watching();
    performer.reconcile([variableSub(), sensorSub()]);
    const old = factory.client("b1");
    old.connect();
    const before = old.wire.length;

    edit("b1", { url: "wss://other.test" });
    expect(old.wire.slice(before)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
    performer.reconcile([sensorSub()]);

    const client = factory.client("b1");
    expect(client.conn.url).toBe("wss://other.test");
    client.connect();
    // The broker at the new URL was never told Studio is connected.
    expect(client.wire).toEqual([subscribed(SENSOR)]);
  });
});

// A connection lasts as long as the flow uses its broker: wants a topic on it,
// or published on it less than `BROKER_IDLE_MS` ago.
describe("CloudPerformer lets go of a broker the flow no longer uses", () => {
  test("a broker the flow stops subscribing on is disconnected, and an edit to its settings then causes no traffic", () => {
    const { performer, factory, edit } = watching();
    performer.reconcile([sensorSub()]);
    const client = factory.client("b1");
    client.connect();

    performer.reconcile([]);
    expect(client.wire).toEqual([subscribed(SENSOR), unsubscribed(SENSOR), DISCONNECT]);
    expect(client.ended).toBe(true);

    edit("b1", { url: "wss://other.test" });
    edit("b1", { url: "wss://third.test" });
    expect(factory.opened).toHaveLength(1);

    // Used again, it is connected to as it is configured then.
    performer.reconcile([sensorSub()]);
    expect(factory.opened).toHaveLength(2);
    expect(factory.client("b1").conn.url).toBe("wss://third.test");
  });

  test("one of two brokers the flow stops using is disconnected; the other is not touched", () => {
    const { performer, factory } = watching([
      { id: "b1", url: "wss://broker.test" },
      { id: "b2", url: "wss://second.test" },
    ]);
    const onSecond: ActiveSub = { brokerId: "b2", topic: "doors/front", nodeId: "door", kind: "plain" };
    performer.reconcile([sensorSub(), onSecond]);
    const first = factory.client("b1");
    const second = factory.client("b2");
    first.connect();
    second.connect();

    performer.reconcile([sensorSub()]);

    expect(second.wire).toEqual([subscribed("doors/front"), unsubscribed("doors/front"), DISCONNECT]);
    expect(first.wire).toEqual([subscribed(SENSOR)]);
    expect(first.ended).toBe(false);
  });

  test("a broker the flow only publishes to keeps its connection between publishes, and loses it once idle", () => {
    const { performer, factory, timers } = watching();
    performer.perform(mqttPublish("lights/kitchen", "on"));
    const client = factory.client("b1");
    client.connect();

    // Every few seconds, for longer than the idle time: one connection.
    for (let sent = 0; sent < 30; sent++) {
      timers.advance(5000);
      performer.perform(mqttPublish("lights/kitchen", "off"));
    }
    // A flow update that has no subscription on it changes nothing either.
    performer.reconcile([]);
    expect(factory.opened).toHaveLength(1);
    expect(client.ended).toBe(false);
    expect(client.wire).toHaveLength(31);

    timers.advance(BROKER_IDLE_MS - 1);
    expect(client.ended).toBe(false);
    timers.advance(1);
    expect(client.ended).toBe(true);
    expect(client.wire.at(-1)).toEqual(DISCONNECT);

    // The next publish opens a connection again, and is sent on it.
    performer.perform(mqttPublish("lights/kitchen", "on"));
    expect(factory.opened).toHaveLength(2);
    const again = factory.client("b1");
    again.connect();
    expect(again.wire).toEqual([published("lights/kitchen", "on")]);
  });

  test("a broker the flow stops subscribing on and still publishes to keeps its connection", () => {
    const { performer, factory, timers } = watching();
    performer.reconcile([sensorSub()]);
    const client = factory.client("b1");
    client.connect();
    performer.perform(mqttPublish("lights/kitchen", "on"));

    performer.reconcile([]);
    expect(client.wire).toEqual([
      subscribed(SENSOR),
      published("lights/kitchen", "on"),
      unsubscribed(SENSOR),
    ]);
    expect(client.ended).toBe(false);

    timers.advance(BROKER_IDLE_MS);
    expect(client.wire.at(-1)).toEqual(DISCONNECT);
  });

  test("a broker published to a while ago follows a change to its settings, and loses that connection once idle", () => {
    const { performer, factory, timers, edit } = watching();
    performer.perform(mqttPublish("lights/kitchen", "on"));
    const client = factory.client("b1");
    client.connect();

    timers.advance(BROKER_IDLE_MS - 100);
    edit("b1", { url: "wss://other.test" });
    expect(client.wire).toEqual([published("lights/kitchen", "on"), DISCONNECT]);
    const next = factory.client("b1");
    expect(next.conn.url).toBe("wss://other.test");
    expect(next.ended).toBe(false);

    // The change was not a use: the idle time ends when it would have.
    timers.advance(100);
    expect(next.ended).toBe(true);
    expect(factory.opened).toHaveLength(2);
  });

  test("a Bridge ID that left a broker whose link is down: the connection waits for the link, takes it back, and closes", () => {
    const { performer, factory, timers } = watching();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();
    const before = client.wire.length;

    client.drop();
    performer.reconcile([]);
    expect(client.ended).toBe(false);

    client.connect();
    expect(client.wire.slice(before)).toEqual([STUDIO_DISCONNECTED]);
    timers.advance(BROKER_IDLE_MS);
    expect(client.wire.slice(before)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
  });

  test("a Bridge ID that left a broker whose link stays down: the connection is closed once idle, with nothing sent", () => {
    const { performer, factory, timers } = watching();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();
    const before = [...client.wire];

    client.drop();
    performer.reconcile([]);
    timers.advance(BROKER_IDLE_MS);

    expect(client.ended).toBe(true);
    client.connect();
    expect(client.wire).toEqual(before);
  });

  test("dispose ends the idle wait", () => {
    const { performer, factory, timers } = watching();
    performer.perform(mqttPublish("lights/kitchen", "on"));
    const client = factory.client("b1");
    client.connect();

    performer.dispose();
    timers.advance(BROKER_IDLE_MS);

    expect(client.wire).toEqual([published("lights/kitchen", "on"), DISCONNECT]);
    expect(factory.opened).toHaveLength(1);
  });
});

// What the flow publishes is for now: it is sent on a link that is up and
// dropped on one that is down, as on the desktop host. Only what Studio owes
// the plugins waits for a link to come back.
describe("CloudPerformer publishes while a link is down", () => {
  test("a flow publish made while the link is down is dropped, and none is replayed when it is back", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { performer, factory } = setup();
      performer.reconcile([sensorSub()]);
      const client = factory.client("b1");
      client.connect();
      performer.perform(mqttPublish("lights/kitchen", "on"));

      client.drop();
      for (let sent = 0; sent < 300; sent++) performer.perform(mqttPublish("lights/kitchen", "off"));
      // Said once for the outage, not once per publish.
      expect(warn).toHaveBeenCalledTimes(1);
      client.connect();

      expect(client.wire).toEqual([
        subscribed(SENSOR),
        published("lights/kitchen", "on"),
        subscribed(SENSOR),
      ]);

      // Back up: sent again. Down again: said again.
      performer.perform(mqttPublish("lights/kitchen", "on"));
      expect(client.wire.at(-1)).toEqual(published("lights/kitchen", "on"));
      client.drop();
      performer.perform(mqttPublish("lights/kitchen", "off"));
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("the publishes that open a connection are sent when it connects, in order, before its subscriptions", () => {
    const { performer, factory } = setup();
    performer.reconcile([]);

    performer.perform(mqttPublish("lights/kitchen", "on"));
    performer.perform(mqttPublish("lights/hall", "on", true));
    const client = factory.client("b1");
    // The broker's CONNACK is in, the client has not said so yet.
    client.accept();
    performer.perform(mqttPublish("lights/kitchen", "off"));
    client.connect();

    expect(client.wire).toEqual([
      published("lights/kitchen", "on"),
      published("lights/hall", "on", true),
      published("lights/kitchen", "off"),
    ]);
    expect(factory.opened).toHaveLength(1);
  });

  test("a connection that does not open in time sends none of the publishes made for it", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { performer, factory, timers } = watching();
      performer.perform(mqttPublish("lights/kitchen", "on"));
      const client = factory.client("b1");
      timers.advance(OPENING_PUBLISH_MS - 1);
      performer.perform(mqttPublish("lights/kitchen", "off"));
      expect(warn).not.toHaveBeenCalled();

      // The broker is not there. Nothing is kept for when it may be.
      timers.advance(1);
      performer.perform(mqttPublish("lights/kitchen", "on"));
      performer.perform(mqttPublish("lights/kitchen", "off"));
      expect(warn).toHaveBeenCalledTimes(1);
      client.connect();
      expect(client.wire).toEqual([]);

      performer.perform(mqttPublish("lights/kitchen", "on"));
      expect(client.wire).toEqual([published("lights/kitchen", "on")]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a Bridge ID that left a broker whose link is down is taken back when the link returns", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { performer, factory } = setup();
      performer.reconcile([variableSub(), sensorSub()]);
      const client = factory.client("b1");
      client.connect();
      const before = client.wire.length;

      client.drop();
      performer.reconcile([sensorSub()]);
      performer.perform(mqttPublish("lights/kitchen", "on"));
      client.connect();

      // The broker held a retained `connected`: that is put right. The flow's
      // publish is not sent late.
      expect(client.wire.slice(before)).toEqual([STUDIO_DISCONNECTED, subscribed(SENSOR)]);
    } finally {
      warn.mockRestore();
    }
  });
});

// A connection that is closed is gone for the flow at once, whatever the
// broker still owes it; the socket follows within `CLOSE_GRACE_MS`.
describe("CloudPerformer closes a connection whose broker still owes an answer", () => {
  const door: ActiveSub = { brokerId: "b1", topic: "doors/front", nodeId: "door", kind: "plain" };

  /** A connection that holds the variable and the sensor topic, removed from
   *  the settings while its SUBSCRIBE for the door is unanswered. */
  function closedWhileWaiting() {
    const rig = watching();
    rig.performer.reconcile([variableSub(), sensorSub()]);
    const client = rig.factory.client("b1");
    client.connect();
    client.deferAcks = true;
    rig.performer.reconcile([variableSub(), sensorSub(), door]);
    const before = client.wire.length;
    rig.edit("b1", undefined);
    return { ...rig, client, before };
  }

  test("it delivers nothing more to the flow, and the plugins are told at once", () => {
    const { client, before, delivered } = closedWhileWaiting();

    // The goodbye is out; the DISCONNECT waits for the answer.
    expect(client.wire.slice(before)).toEqual([STUDIO_DISCONNECTED]);
    expect(client.ended).toBe(true);
    client.deliver(SENSOR, "21");
    client.deliver(VARIABLE, "1");
    expect(delivered).toEqual([]);
  });

  test("it disconnects when the answer arrives within the grace", () => {
    const { client, before, timers } = closedWhileWaiting();

    timers.advance(CLOSE_GRACE_MS - 1);
    client.ack();
    expect(client.wire.slice(before)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);

    timers.advance(CLOSE_GRACE_MS);
    expect(client.wire.slice(before)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
  });

  test("it is cut after the grace when the broker never answers", () => {
    const { client, before, timers } = closedWhileWaiting();

    timers.advance(CLOSE_GRACE_MS - 1);
    expect(client.connected).toBe(true);
    timers.advance(1);

    // No DISCONNECT: the link is closed under the broker.
    expect(client.connected).toBe(false);
    expect(client.wire.slice(before)).toEqual([STUDIO_DISCONNECTED]);
  });

  test("dispose leaves no connection waiting for a broker that never answers", () => {
    const { performer, factory, timers } = watching();
    performer.reconcile([sensorSub()]);
    const client = factory.client("b1");
    client.deferAcks = true;
    client.connect();

    performer.dispose();
    expect(client.connected).toBe(true);
    timers.advance(CLOSE_GRACE_MS);

    expect(client.connected).toBe(false);
    expect(client.wire).toEqual([subscribed(SENSOR)]);
  });
});

// A message does not say which subscription it is for: the session matches its
// topic against every filter it holds, the way the broker did.
describe("CloudPerformer wildcard subscriptions", () => {
  const on = (topic: string, nodeId: string): ActiveSub => ({
    brokerId: "b1",
    topic,
    nodeId,
    kind: "plain",
  });

  test("a node subscribed to a filter gets the messages it matches, each on the topic it was sent on", () => {
    const { performer, factory, delivered, feed } = setup();
    performer.reconcile([on("sensors/#", "all"), on("doors/+/state", "doors")]);
    const client = factory.client("b1");
    client.connect();
    expect(client.wire).toEqual([subscribed("sensors/#"), subscribed("doors/+/state")]);

    client.deliver("sensors/kitchen/temperature", "21");
    client.deliver("sensors", "up");
    client.deliver("doors/front/state", "open");
    client.deliver("doors/front/lock/state", "locked");
    client.deliver("lights/kitchen", "on");

    const expected = [
      { nodeId: "all", topic: "sensors/kitchen/temperature", text: "21" },
      { nodeId: "all", topic: "sensors", text: "up" },
      { nodeId: "doors", topic: "doors/front/state", text: "open" },
    ];
    expect(delivered).toEqual(expected);
    expect(feed).toEqual(expected);
  });

  test("two nodes on overlapping filters each get a message once", () => {
    const { performer, factory, delivered } = setup();
    performer.reconcile([on("sensors/#", "all"), sensorSub("one"), on("sensors/+", "level")]);
    const client = factory.client("b1");
    client.connect();

    client.deliver(SENSOR, "21");

    expect(delivered).toEqual([
      { nodeId: "all", topic: SENSOR, text: "21" },
      { nodeId: "one", topic: SENSOR, text: "21" },
      { nodeId: "level", topic: SENSOR, text: "21" },
    ]);
  });

  test("a filter that is let go of stops receiving, and the ones that overlap it go on", () => {
    const { performer, factory, delivered } = setup();
    performer.reconcile([on("sensors/#", "all"), sensorSub("one")]);
    const client = factory.client("b1");
    client.connect();

    performer.reconcile([sensorSub("one")]);
    client.deliver(SENSOR, "21");
    client.deliver("sensors/humidity", "40");

    expect(delivered).toEqual([{ nodeId: "one", topic: SENSOR, text: "21" }]);
  });

  test("a shared subscription receives on the plain topic, and # does not receive $SYS", () => {
    const { performer, factory, delivered } = setup();
    performer.reconcile([on("$share/studio/sensors/#", "shared"), on("#", "everything")]);
    const client = factory.client("b1");
    client.connect();

    client.deliver(SENSOR, "21");
    client.deliver("$SYS/broker/uptime", "7");

    expect(delivered).toEqual([
      { nodeId: "shared", topic: SENSOR, text: "21" },
      { nodeId: "everything", topic: SENSOR, text: "21" },
    ]);
  });
});

/** A performer whose announce policy throws once `trap()` was called: the
 *  compiled policy after its module trapped. `askedAfterTrap` counts the
 *  calls made to it since. */
function trappable(conns: BrokerConn[] = [{ id: "b1", url: "wss://broker.test" }]) {
  const factory = new StubMqttClientFactory();
  const brokers = new Map<string, BrokerConn>(conns.map((conn) => [conn.id, conn] as const));
  let trapped = false;
  let askedAfterTrap = 0;
  const performer = new CloudPerformer(
    { resolveLlmProvider: () => undefined, resolveBroker: (id) => brokers.get(id) },
    () => {},
    () => {},
    (prev, next) => {
      if (trapped) {
        askedAfterTrap += 1;
        throw new Error("unreachable");
      }
      return figmaAnnounceStub(prev, next);
    },
    factory,
  );
  return {
    performer,
    factory,
    brokers,
    trap: () => {
      trapped = true;
    },
    askedAfterTrap: () => askedAfterTrap,
  };
}

// The plugins are told Studio left also when the flow engine, which the policy
// runs in, has died: what to say was asked of the policy when it announced.
// Closing the connections never depends on the policy.
/** The will of a link to broker `b1` once Studio is announced there for
 *  `uid-1`: its `disconnected`. */
const UID_1_GONE: Will = { topic: "microflow/uid-1/app/status", payload: "disconnected", retain: true };

describe("CloudPerformer leaves the first goodbye with the broker as its links' will", () => {
  test("once announced, a new link carries the will and takes the subscriptions over; the old one says DISCONNECT", () => {
    const { performer, factory, delivered } = setup();
    performer.reconcile([sensorSub(), variableSub()]);
    const client = factory.client("b1");
    client.connect();
    expect(client.will).toBeUndefined();

    const renewal = factory.renewal("b1");
    expect(renewal.will).toEqual(UID_1_GONE);
    renewal.connect();

    // Nothing said: no `disconnected`, no second `connected`.
    expect(renewal.wire).toEqual([subscribed(SENSOR), subscribed(VARIABLE)]);
    expect(client.wire).toEqual([
      subscribed(SENSOR),
      subscribed(VARIABLE),
      STUDIO_CONNECTED,
      VARIABLES_REQUEST,
      DISCONNECT,
    ]);
    // The new link is the one in use.
    expect(factory.client("b1")).toBe(renewal);
    renewal.deliver(SENSOR, "21");
    expect(delivered).toEqual([{ nodeId: "mqtt", topic: SENSOR, text: "21" }]);
  });

  test("a renewed link hands a node no retained value it had, and every live message once", () => {
    const { performer, factory, delivered } = setup();
    performer.reconcile([sensorSub(), variableSub()]);
    const client = factory.client("b1");
    client.connect();
    client.deliver(SENSOR, "21", true);

    const renewal = factory.renewal("b1");
    renewal.connect();
    // The broker answers the new link's SUBSCRIBE with the retained value.
    renewal.deliver(SENSOR, "21", true);
    // The old link is not listened to any more.
    client.deliver(SENSOR, "22");
    renewal.deliver(SENSOR, "22");

    expect(delivered.map(({ text }) => text)).toEqual(["21", "22"]);
  });

  test("a Bridge ID that leaves while the connection stays takes the will with it", () => {
    const { performer, factory } = setup();
    performer.reconcile([sensorSub(), variableSub()]);
    factory.client("b1").connect();
    const renewed = factory.renewal("b1");
    renewed.connect();

    performer.reconcile([sensorSub()]);

    expect(renewed.wire.slice(2)).toEqual([unsubscribed(VARIABLE), STUDIO_DISCONNECTED]);
    const next = factory.renewal("b1");
    expect(next.will).toBeUndefined();
    next.connect();
    expect(next.wire).toEqual([subscribed(SENSOR)]);
    expect(renewed.wire.at(-1)).toEqual(DISCONNECT);
  });

  test("with two Bridge IDs on a broker, the will is the goodbye of the first in uid order", () => {
    const { performer, factory } = setup();
    const uid0: ActiveSub = {
      brokerId: "b1",
      topic: "microflow/uid-0/figma/variable/3",
      nodeId: "zero",
      kind: "topicAware",
    };
    performer.reconcile([variableSub(), uid0]);
    // `uid-1`'s topic is held first: its goodbye is the will until `uid-0` is
    // announced too.
    factory.client("b1").connect();
    const first = factory.renewal("b1");
    expect(first.will).toEqual(UID_1_GONE);

    // The will changed while the new link was opened: it is renewed again
    // once that one is in use.
    first.connect();
    const second = factory.renewal("b1");
    expect(second.will).toEqual({ ...UID_1_GONE, topic: "microflow/uid-0/app/status" });
    second.connect();
    expect(second.wire).toEqual([subscribed(VARIABLE), subscribed(uid0.topic)]);
    expect(first.wire.at(-1)).toEqual(DISCONNECT);
  });

  /** Variable nodes of Bridge IDs `uid-0` and `uid-1` on broker `b1`, both
   *  announced, the link renewed to carry `uid-0`'s goodbye and `uid-1`'s will
   *  link up. */
  function twoAnnounced() {
    const fixture = setup();
    const { performer, factory } = fixture;
    performer.reconcile([variableSub(), UID_0_SUB]);
    factory.client("b1").connect();
    factory.renewal("b1").connect();
    factory.renewal("b1").connect();
    const [willLink] = factory.willLinks;
    willLink.connect();
    return { ...fixture, link: factory.client("b1"), willLink };
  }
  const UID_0_SUB: ActiveSub = {
    brokerId: "b1",
    topic: "microflow/uid-0/figma/variable/3",
    nodeId: "zero",
    kind: "topicAware",
  };
  const UID_0_GONE: Will = { ...UID_1_GONE, topic: "microflow/uid-0/app/status" };

  test("with two Bridge IDs on a broker, the second one's goodbye is the will of a will link that does nothing else", () => {
    const { factory, link, willLink } = twoAnnounced();

    expect(link.will).toEqual(UID_0_GONE);
    expect(factory.willLinks).toHaveLength(1);
    expect(willLink.will).toEqual(UID_1_GONE);
    expect(willLink.wire).toEqual([]);
    expect(willLink.ended).toBe(false);
  });

  test("a Bridge ID that leaves: its will link says the goodbye and then DISCONNECT, and the link says nothing", () => {
    const { performer, link, willLink } = twoAnnounced();

    performer.reconcile([UID_0_SUB]);

    expect(link.wire.at(-1)).toEqual(unsubscribed(VARIABLE));
    expect(willLink.wire).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
    expect(willLink.ended).toBe(true);
  });

  test("a Bridge ID that leaves while its will link is down: the link says the goodbye, and the will link is closed", () => {
    const { performer, link, willLink } = twoAnnounced();
    willLink.drop();

    performer.reconcile([UID_0_SUB]);

    expect(link.wire.slice(-2)).toEqual([unsubscribed(VARIABLE), STUDIO_DISCONNECTED]);
    expect(willLink.wire).toEqual([]);
    expect(willLink.ended).toBe(true);
  });

  test("a connection closed on purpose: each link says its own goodbye, then DISCONNECT", () => {
    const { performer, link, willLink } = twoAnnounced();

    performer.dispose();

    expect(link.wire.slice(-2)).toEqual([published(UID_0_GONE.topic, "disconnected", true), DISCONNECT]);
    expect(willLink.wire).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
  });

  test("a page that goes away says every goodbye and leaves every will link's will in place", () => {
    const { performer, factory, link, willLink } = twoAnnounced();

    performer.leave();

    expect(link.wire.slice(-2)).toEqual([published(UID_0_GONE.topic, "disconnected", true), STUDIO_DISCONNECTED]);
    expect(willLink.ended).toBe(false);
    expect(willLink.wire).toEqual([]);
    // Back from the cache: announced again, on the links there are.
    performer.rejoin();
    expect(factory.willLinks).toHaveLength(1);
    expect(willLink.ended).toBe(false);
  });

  test("a will link never changes what the connection reports", () => {
    const { performer, factory, willLink, delivered } = twoAnnounced();

    willLink.drop();
    performer.reconcile([variableSub(), UID_0_SUB, sensorSub()]);
    factory.client("b1").deliver(SENSOR, "21");

    expect(delivered).toEqual([{ nodeId: "mqtt", topic: SENSOR, text: "21" }]);
  });

  test("a will that changed while the link was down is carried by a link renewed once it is back", () => {
    const { performer, factory } = setup();
    performer.reconcile([sensorSub(), variableSub()]);
    factory.client("b1").connect();
    const renewed = factory.renewal("b1");
    renewed.connect();

    renewed.drop();
    performer.reconcile([sensorSub()]);
    expect(factory.renewals).toHaveLength(1);

    // What it stored goes first; then the link is renewed without the will.
    renewed.connect();
    expect(renewed.wire.slice(2)).toEqual([STUDIO_DISCONNECTED, subscribed(SENSOR)]);
    expect(factory.renewal("b1").will).toBeUndefined();
  });

  test("a renewal that does not connect in time is closed; the link in use is renewed when it is repaired", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { performer, factory, timers } = setup();
      performer.reconcile([variableSub()]);
      const client = factory.client("b1");
      client.connect();
      const late = factory.renewal("b1");

      timers.advance(RENEW_MS);
      expect(late.ended).toBe(true);
      expect(late.wire).toEqual([]);
      expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
        "[mqtt] broker b1: the new link for its will did not connect; the link in use keeps its will",
      ]);

      client.drop();
      client.connect();
      expect(factory.renewal("b1").will).toEqual(UID_1_GONE);
    } finally {
      warn.mockRestore();
    }
  });

  test("a renewal whose old link dropped meanwhile says DISCONNECT; the old link is renewed once it is repaired", () => {
    const { performer, factory } = setup();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();
    const first = factory.renewal("b1");

    client.drop();
    first.connect();
    expect(first.wire).toEqual([DISCONNECT]);
    expect(first.ended).toBe(true);

    // What the old link stored for its link goes out on it.
    client.connect();
    const second = factory.renewal("b1");
    expect(second).not.toBe(first);
    second.connect();
    expect(second.wire).toEqual([subscribed(VARIABLE)]);
    expect(client.wire.at(-1)).toEqual(DISCONNECT);
  });

  test("a connection closed while its link is renewed says goodbye on the link in use, and closes the new one too", () => {
    const { performer, factory } = setup();
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();
    const renewal = factory.renewal("b1");

    performer.reconcile([]);

    expect(client.wire.slice(3)).toEqual([unsubscribed(VARIABLE), STUDIO_DISCONNECTED, DISCONNECT]);
    expect(renewal.ended).toBe(true);
    expect(renewal.wire).toEqual([]);
  });

  test("a page that goes away says goodbye itself and keeps the will; one back from the cache announces again with no new link", () => {
    const { performer, factory } = setup();
    performer.reconcile([variableSub()]);
    factory.client("b1").connect();
    const renewed = factory.renewal("b1");
    renewed.connect();

    performer.leave();
    expect(renewed.wire.slice(1)).toEqual([STUDIO_DISCONNECTED]);
    performer.rejoin();
    expect(renewed.wire.slice(2)).toEqual([STUDIO_CONNECTED, VARIABLES_REQUEST]);
    expect(factory.renewals).toHaveLength(1);
    expect(renewed.ended).toBe(false);
  });
});

describe("CloudPerformer teardown", () => {
  test("after the policy's module trapped, dispose takes back every Bridge ID without asking it, and ends every connection", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { performer, factory, trap, askedAfterTrap } = trappable([
        { id: "b1", url: "wss://broker.test" },
        { id: "b2", url: "wss://second.test" },
      ]);
      const onSecond: ActiveSub = {
        brokerId: "b2",
        topic: "microflow/uid-2/figma/variable/3-4",
        nodeId: "fig-2",
        kind: "topicAware",
      };
      performer.reconcile([variableSub(), onSecond]);
      const first = factory.client("b1");
      const second = factory.client("b2");
      first.connect();
      second.connect();

      trap();
      expect(() => performer.dispose()).not.toThrow();

      expect(first.wire.slice(3)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
      expect(second.wire.slice(3)).toEqual([
        published("microflow/uid-2/app/status", "disconnected", true),
        DISCONNECT,
      ]);
      expect(first.ended).toBe(true);
      expect(second.ended).toBe(true);
      expect(askedAfterTrap()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("after the policy's module trapped, a removed broker is told Studio left without asking it, and closed", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { performer, factory, brokers, trap, askedAfterTrap } = trappable();
      performer.reconcile([variableSub(), sensorSub()]);
      const client = factory.client("b1");
      client.connect();
      const before = client.wire.length;

      trap();
      brokers.delete("b1");
      expect(() => performer.perform(mqttPublish("lights/kitchen", "on"))).not.toThrow();

      expect(client.wire.slice(before)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
      expect(client.ended).toBe(true);
      expect(askedAfterTrap()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("a disposed performer performs nothing: no connection is opened, no provider called", async () => {
    let fetched = 0;
    stubFetch((async () => {
      fetched += 1;
      return streamResponse(["late"]);
    }) as unknown as typeof fetch);
    const { performer, factory, injects } = setup();
    performer.dispose();

    performer.perform(mqttPublish("lights/kitchen", "on"));
    performer.reconcile([sensorSub(), variableSub()]);
    performer.perform(llmRequest("llm", "hello"));
    await delay(20);

    expect(factory.opened).toEqual([]);
    expect(fetched).toBe(0);
    expect(injects).toEqual([]);
  });

  test("a settings watch that cannot be ended still ends every connection", () => {
    const factory = new StubMqttClientFactory();
    const performer = new CloudPerformer(
      {
        resolveLlmProvider: () => undefined,
        resolveBroker: (id) => ({ id, url: `wss://${id}.test` }),
        watchBrokers: () => () => {
          throw new Error("the store is gone");
        },
      },
      () => {},
      () => {},
      figmaAnnounceStub,
      factory,
    );
    performer.reconcile([variableSub()]);
    const client = factory.client("b1");
    client.connect();

    expect(() => performer.dispose()).toThrow("the store is gone");

    expect(client.wire.slice(3)).toEqual([STUDIO_DISCONNECTED, DISCONNECT]);
    expect(client.ended).toBe(true);
  });
});
