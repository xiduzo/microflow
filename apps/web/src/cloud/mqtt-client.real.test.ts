// `BrokerConnections` over the real `mqtt.js` client, made by the production
// factory, against a scripted broker on a loopback WebSocket.
//
// `cloud-performer.test.ts` plays the broker with a fake client; this file is
// what keeps that fake honest. It pins the things only the real client can
// show: what a refused SUBSCRIBE looks like to its callback, that `mqtt.js`
// subscribes nothing by itself after a reconnect, the order of what it sends
// on connect, that a connection which is closed sends what it was just given
// before it disconnects, and that a link carries the will it is given to the
// broker, which publishes it only when the link ends without a DISCONNECT.
//
// The last tests put the `CloudPerformer` on top of the production factory:
// from a settled change to a broker's settings to the SUBSCRIBE on the new
// connection, the design-tool handshake and goodbye in wire order, and the
// will that says the goodbye for a Studio that could not.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";
import type { FigmaAnnounce } from "./cloud-performer";
import { startScriptedBroker, until, type ScriptedBroker } from "./scripted-broker";
import { FIGMA_ANNOUNCE_CASES } from "@/lib/figma-announce-cases";

// `mock.module` is process-wide, and `connection-console/broker-transport.test.ts`
// mocks "mqtt". Whichever file runs first, this one gets the real client: it loads
// the module behind the package entry, which no mock names, and puts it back
// under "mqtt" before the code under test imports it.
const require = createRequire(import.meta.url);
const realMqtt: object = require(path.join(path.dirname(require.resolve("mqtt")), "mqtt.js"));
mock.module("mqtt", () => ({ ...realMqtt, default: realMqtt }));

const { BrokerConnections, CLOSE_GRACE_MS, COPY_WINDOW_MS } = await import("./mqtt-client");
const { CloudPerformer } = await import("./cloud-performer");

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/**
 * The Figma Announce Policy, read off the table the compiled policy is held to
 * (`runtime/figma-announce.wasm.test.ts`): the publishes of the row for this
 * transition. The compiled policy itself is the runtime vertical's. A
 * transition the table does not hold fails the test that made it.
 */
const announceFromTable: FigmaAnnounce = (prev, next) => {
  const key = (uids: Record<string, string>) => JSON.stringify(Object.entries(uids).sort());
  const row = FIGMA_ANNOUNCE_CASES.find(
    (known) => key(known.prev) === key(prev) && key(known.next) === key(next),
  );
  if (!row) throw new Error(`the announce table has no row for ${key(prev)} -> ${key(next)}`);
  return row.publishes;
};

/** A publish that waits for a link that is down, as Studio's status does. */
const STATUS = { retain: true, whenDown: "keep" } as const;
/** A publish that is sent now or not at all, as a flow's is. */
const FLOW = { retain: false, whenDown: "drop" } as const;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function broker(): ScriptedBroker {
  const started = startScriptedBroker();
  cleanups.push(started.stop);
  return started;
}

/** Connections over the production factory, and what they reported. */
function connections(beforeLeaving?: (brokerId: string) => void) {
  const made = new BrokerConnections(undefined, beforeLeaving);
  cleanups.unshift(() => made.disposeAll());
  const outcomes: string[] = [];
  const received: string[] = [];
  return {
    made,
    outcomes,
    received,
    /** Ask for `topic` on broker `b`, recording what its watcher and handler get. */
    subscribe(topic: string): void {
      made.subscribe(
        "b",
        topic,
        (on, payload) => received.push(`${on} ${new TextDecoder().decode(payload)}`),
        (held) => outcomes.push(`${topic} ${held ? "held" : "refused"}`),
      );
    },
  };
}

describe("BrokerConnections over the real mqtt.js client", () => {
  test("topics asked before the broker connects are subscribed when it does", async () => {
    const mosquitto = broker();
    const { made, outcomes, subscribe } = connections();

    expect(made.configure("b", { id: "b", url: mosquitto.url })).toEqual({ open: true, changed: true });
    subscribe("a");
    subscribe("b");
    expect(made.publish("b", "early", text("stored"), STATUS)).toBe("kept");
    expect(made.publish("b", "first", text("flow"), FLOW)).toBe("kept");
    await until(() => outcomes.length === 2);

    // What was published while connecting goes first: what the client stored,
    // then what was kept for the first connect.
    expect(mosquitto.packets()).toEqual([
      "CONNECT",
      "PUBLISH early stored retain",
      "PUBLISH first flow",
      "SUBSCRIBE a",
      "SUBSCRIBE b",
    ]);
    expect(outcomes).toEqual(["a held", "b held"]);
  });

  test("a refused topic is not held, and every retry is a real SUBSCRIBE", async () => {
    const mosquitto = broker();
    const { made, outcomes, received, subscribe } = connections();
    mosquitto.refuse("secret");
    made.configure("b", { id: "b", url: mosquitto.url });

    subscribe("secret");
    await until(() => outcomes.length === 1);
    subscribe("secret");
    await until(() => outcomes.length === 2);
    expect(outcomes).toEqual(["secret refused", "secret refused"]);
    expect(mosquitto.count("SUBSCRIBE secret")).toBe(2);

    mosquitto.acceptAll();
    subscribe("secret");
    await until(() => outcomes.length === 3);
    expect(outcomes.at(-1)).toBe("secret held");
    expect(mosquitto.count("SUBSCRIBE secret")).toBe(3);

    // Held: asked once more, the broker is not, and its messages arrive.
    subscribe("secret");
    expect(outcomes).toHaveLength(4);
    mosquitto.publish("secret", "21");
    await until(() => received.length === 1);
    expect(received).toEqual(["secret 21"]);
    expect(mosquitto.count("SUBSCRIBE secret")).toBe(3);
  });

  test(
    "after a lost link every topic is subscribed once on the new one, a refusal is seen, and only what was to be kept is sent late",
    async () => {
      const mosquitto = broker();
      const { made, outcomes, subscribe } = connections();
      made.configure("b", { id: "b", url: mosquitto.url });
      subscribe("a");
      subscribe("b");
      await until(() => outcomes.length === 2);

      mosquitto.refuse("b");
      mosquitto.drop();
      made.unsubscribe("b", "gone-while-down");
      // Until the client has seen the link go.
      await until(() => made.publish("b", "flow/out", text("on"), FLOW) === "dropped");
      for (let late = 0; late < 300; late++) {
        expect(made.publish("b", "flow/out", text("on"), FLOW)).toBe("dropped");
      }
      expect(made.publish("b", "app/status", text("disconnected"), STATUS)).toBe("kept");
      // The client reconnects by itself, a few seconds later.
      await until(() => mosquitto.count("SUBSCRIBE") === 4, 12_000);
      await until(() => outcomes.length === 4);
      // Whatever else the reconnect sent was written before this.
      expect(made.publish("b", "marker", text("after"), FLOW)).toBe("sent");
      await until(() => mosquitto.count("PUBLISH marker") === 1);

      expect(mosquitto.packets().slice(3)).toEqual([
        "CONNECT",
        "PUBLISH app/status disconnected retain",
        "SUBSCRIBE a",
        "SUBSCRIBE b",
        "PUBLISH marker after",
      ]);
      expect(outcomes.slice(2)).toEqual(["a held", "b refused"]);
    },
    20_000,
  );

  test("a connection replaced while a subscribe is unanswered reports nothing for it", async () => {
    const old = broker();
    const next = broker();
    const { made, outcomes, subscribe } = connections();
    old.holdAnswers();
    made.configure("b", { id: "b", url: old.url });
    subscribe("a");
    await until(() => old.count("SUBSCRIBE a") === 1);

    expect(made.configure("b", { id: "b", url: next.url })).toEqual({ open: true, changed: true });
    old.release();
    // The old connection ends once its answer is in; it is not waited for.
    await until(() => old.count("DISCONNECT") === 1);
    expect(outcomes).toEqual([]);

    subscribe("a");
    await until(() => outcomes.length === 1);
    expect(outcomes).toEqual(["a held"]);
    expect(next.packets()).toEqual(["CONNECT", "SUBSCRIBE a"]);
  });

  test("a connection replaced before it connected sends nothing, not even what it had stored", async () => {
    const old = broker();
    const next = broker();
    const { made, outcomes, subscribe } = connections();

    // All in one go: the first connection is still being opened when it is replaced.
    made.configure("b", { id: "b", url: old.url });
    made.publish("b", "stored", text("for the old broker"), STATUS);
    made.publish("b", "kept", text("for the old broker"), FLOW);
    made.configure("b", { id: "b", url: next.url });
    subscribe("a");
    await until(() => outcomes.length === 1);
    made.publish("b", "marker", text("after"), FLOW);
    await until(() => next.count("PUBLISH marker") === 1);

    expect(old.packets()).toEqual([]);
    expect(next.packets()).toEqual(["CONNECT", "SUBSCRIBE a", "PUBLISH marker after"]);
  });

  test("what is published as a connection closes is sent before it disconnects", async () => {
    const old = broker();
    const next = broker();
    const { made, outcomes, subscribe } = connections((brokerId) =>
      made.publish(brokerId, "app/status", text("disconnected"), STATUS),
    );
    made.configure("b", { id: "b", url: old.url });
    subscribe("a");
    await until(() => outcomes.length === 1);

    // Replaced…
    made.configure("b", { id: "b", url: next.url });
    await until(() => old.count("DISCONNECT") === 1);
    expect(old.packets().slice(2)).toEqual(["PUBLISH app/status disconnected retain", "DISCONNECT"]);

    // …and closed for good.
    subscribe("a");
    await until(() => outcomes.length === 2);
    made.disposeAll();
    await until(() => next.count("DISCONNECT") === 1);
    expect(next.packets().slice(2)).toEqual(["PUBLISH app/status disconnected retain", "DISCONNECT"]);
  });

  test(
    "a closed connection delivers nothing more, and is cut when the broker never answers",
    async () => {
      const mosquitto = broker();
      const { made, outcomes, received, subscribe } = connections((brokerId) =>
        made.publish(brokerId, "app/status", text("disconnected"), STATUS),
      );
      made.configure("b", { id: "b", url: mosquitto.url });
      subscribe("a");
      await until(() => outcomes.length === 1);
      // From here on the broker answers no SUBSCRIBE.
      mosquitto.holdAnswers();
      subscribe("pending");
      await until(() => mosquitto.count("SUBSCRIBE pending") === 1);

      made.configure("b", undefined);
      mosquitto.publish("a", "late");
      // What was said as it closed is not held up by the missing answer.
      await until(() => mosquitto.count("PUBLISH app/status disconnected retain") === 1);
      expect(mosquitto.connections()).toBe(1);

      await until(() => mosquitto.connections() === 0, CLOSE_GRACE_MS + 3000);
      expect(received).toEqual([]);
      expect(outcomes).toEqual(["a held"]);
      // Cut, not disconnected: the DISCONNECT was waiting for the answer.
      expect(mosquitto.count("DISCONNECT")).toBe(0);
    },
    CLOSE_GRACE_MS + 8000,
  );

  test("a message goes to every subscription whose filter matches its topic, once each", async () => {
    const mosquitto = broker();
    const { made } = connections();
    const got: string[] = [];
    let held = 0;
    made.configure("b", { id: "b", url: mosquitto.url });
    for (const filter of ["sensors/#", "sensors/+/temperature", "sensors/kitchen/temperature"]) {
      made.subscribe(
        "b",
        filter,
        (topic, payload) => got.push(`${filter} <- ${topic} ${new TextDecoder().decode(payload)}`),
        () => (held += 1),
      );
    }
    await until(() => held === 3);

    // This broker sends each message once, whatever number of filters it matches.
    mosquitto.publish("sensors/kitchen/temperature", "21");
    mosquitto.publish("sensors/hall/humidity", "40");
    await until(() => got.length === 4);

    expect(got).toEqual([
      "sensors/# <- sensors/kitchen/temperature 21",
      "sensors/+/temperature <- sensors/kitchen/temperature 21",
      "sensors/kitchen/temperature <- sensors/kitchen/temperature 21",
      "sensors/# <- sensors/hall/humidity 40",
    ]);
  });

  test("a broker that sends a copy per matching subscription reaches each one once per message", async () => {
    const mosquitto = broker();
    mosquitto.copyPerSubscription();
    const { made } = connections();
    const got: string[] = [];
    let held = 0;
    made.configure("b", { id: "b", url: mosquitto.url });
    for (const filter of ["sensors/#", "sensors/+/temperature", "sensors/kitchen/temperature"]) {
      made.subscribe(
        "b",
        filter,
        (topic, payload) => got.push(`${filter} <- ${topic} ${new TextDecoder().decode(payload)}`),
        () => (held += 1),
      );
    }
    await until(() => held === 3);

    mosquitto.publish("sensors/kitchen/temperature", "21");
    await until(() => got.length === 3);
    // The same value, published again a moment later, is a new message.
    await new Promise((resolve) => setTimeout(resolve, COPY_WINDOW_MS * 3));
    mosquitto.publish("sensors/kitchen/temperature", "21");
    await until(() => got.length === 6);
    await new Promise((resolve) => setTimeout(resolve, COPY_WINDOW_MS * 3));

    const once = [
      "sensors/# <- sensors/kitchen/temperature 21",
      "sensors/+/temperature <- sensors/kitchen/temperature 21",
      "sensors/kitchen/temperature <- sensors/kitchen/temperature 21",
    ];
    expect(got).toEqual([...once, ...once]);
  });

  test("a retained value reaches the subscription that asked for it, and no other again", async () => {
    const mosquitto = broker();
    mosquitto.retain("sensors/kitchen", "21");
    const { made } = connections();
    const got: string[] = [];
    let held = 0;
    made.configure("b", { id: "b", url: mosquitto.url });
    const subscribe = (filter: string) =>
      made.subscribe(
        "b",
        filter,
        (topic, payload) => got.push(`${filter} <- ${topic} ${new TextDecoder().decode(payload)}`),
        () => (held += 1),
      );

    subscribe("sensors/kitchen");
    await until(() => got.length === 1);
    // The broker answers this SUBSCRIBE with the retained value too.
    subscribe("sensors/#");
    await until(() => got.length === 2);
    mosquitto.publish("sensors/kitchen", "22");
    await until(() => got.length === 4);

    expect(got).toEqual([
      "sensors/kitchen <- sensors/kitchen 21",
      "sensors/# <- sensors/kitchen 21",
      "sensors/kitchen <- sensors/kitchen 22",
      "sensors/# <- sensors/kitchen 22",
    ]);
  });

  test("a topic with a wildcard is never published, so the broker keeps the connection", async () => {
    const mosquitto = broker();
    const { made, outcomes, received, subscribe } = connections();
    made.configure("b", { id: "b", url: mosquitto.url });
    subscribe("a");
    await until(() => outcomes.length === 1);

    expect(made.publish("b", "microflow/+/app/status", text("connected"), STATUS)).toBe("invalid");
    expect(made.publish("b", "sensors/#", text("on"), FLOW)).toBe("invalid");
    expect(made.publish("b", "marker", text("after"), FLOW)).toBe("sent");
    await until(() => mosquitto.count("PUBLISH marker") === 1);
    mosquitto.publish("a", "still here");
    await until(() => received.length === 1);

    expect(mosquitto.packets()).toEqual(["CONNECT", "SUBSCRIBE a", "PUBLISH marker after"]);
    expect(mosquitto.connections()).toBe(1);
  });

  test("a will is carried by a new link that takes the subscriptions over; the old link says DISCONNECT", async () => {
    const mosquitto = broker();
    const { made, outcomes, subscribe } = connections();
    made.configure("b", { id: "b", url: mosquitto.url });
    subscribe("a");
    await until(() => outcomes.length === 1);

    made.setWill("b", { topic: "app/status", payload: "disconnected", retain: true });
    await until(() => mosquitto.count("DISCONNECT") === 1);

    expect(mosquitto.packets().slice(0, 3)).toEqual([
      "CONNECT",
      "SUBSCRIBE a",
      "CONNECT will app/status disconnected retain",
    ]);
    // On two sockets: the new link's SUBSCRIBE and the old link's DISCONNECT.
    expect(mosquitto.packets().slice(3).sort()).toEqual(["DISCONNECT", "SUBSCRIBE a"]);
    await until(() => mosquitto.connections() === 1);
    // The old link's DISCONNECT dropped its will (it had none); nothing was said.
    expect(mosquitto.wills()).toEqual([]);
    expect(outcomes).toEqual(["a held", "a held"]);
  });

  test("a link that ends without a DISCONNECT leaves its will with the broker; one that says DISCONNECT does not", async () => {
    const lost = broker();
    const left = broker();
    const { made, outcomes } = connections();
    for (const mosquitto of [lost, left]) {
      const id = mosquitto === lost ? "lost" : "left";
      made.configure(id, { id, url: mosquitto.url });
      made.subscribe(id, "a", () => {}, (held) => outcomes.push(`${id} ${held}`));
      await until(() => outcomes.includes(`${id} true`));
      made.setWill(id, { topic: "app/status", payload: "disconnected", retain: true });
      await until(() => mosquitto.count("DISCONNECT") === 1 && mosquitto.connections() === 1);
    }

    // A lost network, a tab that crashed: the broker says it for the client.
    lost.drop();
    await until(() => lost.wills().length === 1);
    expect(lost.wills()).toEqual(["app/status disconnected retain"]);
    expect(lost.retained("app/status")).toBe("disconnected");

    // A goodbye: the DISCONNECT drops the will.
    made.configure("left", undefined);
    await until(() => left.count("DISCONNECT") === 2 && left.connections() === 0);
    expect(left.wills()).toEqual([]);
    expect(left.retained("app/status")).toBeUndefined();
  });

  test("a will renewed twice: each new link has a new client id, nothing is said, and no retained value arrives twice", async () => {
    const mosquitto = broker();
    mosquitto.retain("a", "21");
    const { made, received, subscribe } = connections();
    made.configure("b", { id: "b", url: mosquitto.url });
    subscribe("a");
    await until(() => received.length === 1);

    made.setWill("b", { topic: "app/one", payload: "gone", retain: true });
    await until(() => mosquitto.count("DISCONNECT") === 1 && mosquitto.connections() === 1);
    made.setWill("b", { topic: "app/two", payload: "gone", retain: true });
    await until(() => mosquitto.count("DISCONNECT") === 2 && mosquitto.connections() === 1);
    await until(() => mosquitto.count("SUBSCRIBE a") === 3);

    // A new link with the client id of the one it replaces would have ended
    // that one at the broker, and so published its will.
    expect(mosquitto.wills()).toEqual([]);
    // The broker answered each new SUBSCRIBE with the retained value; the
    // subscription had it.
    mosquitto.publish("a", "22");
    await until(() => received.length === 2);
    expect(received).toEqual(["a 21", "a 22"]);
  });

  test("a URL no connection can be opened to throws nothing and leaves the broker without one", () => {
    const { made } = connections();
    for (const url of ["ws://a b", "ws://[", "ws://host:99999"]) {
      expect(made.configure("b", { id: "b", url })).toEqual({ open: false, changed: false });
    }
  });
});

describe("CloudPerformer over the real mqtt.js client", () => {
  test(
    "a running flow's subscription moves to its broker's corrected URL, with no flow update",
    async () => {
      const old = broker();
      const next = broker();
      // The settled settings of broker `b`, and who watches them.
      let url = old.url;
      const watchers = new Set<(brokerIds: readonly string[]) => void>();
      const delivered: string[] = [];
      const performer = new CloudPerformer(
        {
          resolveLlmProvider: () => undefined,
          resolveBroker: (id) => ({ id, url }),
          watchBrokers: (onChange) => {
            watchers.add(onChange);
            return () => watchers.delete(onChange);
          },
        },
        () => {},
        (nodeId, topic, payload) =>
          delivered.push(`${nodeId} ${topic} ${new TextDecoder().decode(payload)}`),
        () => [],
      );
      cleanups.unshift(() => performer.dispose());
      performer.reconcile([{ brokerId: "b", topic: "a", nodeId: "n", kind: "plain" }]);
      await until(() => old.count("SUBSCRIBE a") === 1);

      url = next.url;
      for (const watcher of watchers) watcher(["b"]);
      await until(() => next.count("SUBSCRIBE a") === 1, 3000);
      await until(() => old.count("DISCONNECT") === 1);
      expect(next.packets()).toEqual(["CONNECT", "SUBSCRIBE a"]);
      next.publish("a", "21");
      await until(() => delivered.length === 1);
      expect(delivered).toEqual(["n a 21"]);
    },
    10_000,
  );

  test(
    "the design-tool handshake: announced after the SUBACK, taken back before the DISCONNECT, made again on the new connection",
    async () => {
      const old = broker();
      const next = broker();
      // Bridge ID `alpha` on broker `b1`, as the announce table names them.
      const variable = "microflow/alpha/figma/variable/1-2";
      const CONNECTED = "PUBLISH microflow/alpha/app/status connected retain";
      const REQUEST = "PUBLISH microflow/alpha/app/variables/request ";
      const DISCONNECTED = "PUBLISH microflow/alpha/app/status disconnected retain";
      let url = old.url;
      const watchers = new Set<(brokerIds: readonly string[]) => void>();
      const performer = new CloudPerformer(
        {
          resolveLlmProvider: () => undefined,
          resolveBroker: (id) => ({ id, url }),
          watchBrokers: (onChange) => {
            watchers.add(onChange);
            return () => watchers.delete(onChange);
          },
        },
        () => {},
        () => {},
        announceFromTable,
      );
      cleanups.unshift(() => performer.dispose());

      // Nothing is announced before the broker holds the subscription.
      old.holdAnswers();
      performer.reconcile([{ brokerId: "b1", topic: variable, nodeId: "fig", kind: "topicAware" }]);
      await until(() => old.count("SUBSCRIBE") === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(old.packets()).toEqual(["CONNECT", `SUBSCRIBE ${variable}`]);
      old.release();
      await until(() => old.count(REQUEST) === 1);
      expect(old.packets().slice(2, 4)).toEqual([CONNECTED, REQUEST]);
      // The goodbye becomes the will: a new link carries it.
      const withWill = "CONNECT will microflow/alpha/app/status disconnected retain";
      const renewed = (mosquitto: ScriptedBroker) =>
        until(() => mosquitto.count("DISCONNECT") === 1 && mosquitto.connections() === 1);
      await renewed(old);
      expect(old.packets()[4]).toBe(withWill);

      // The broker's URL is corrected: Studio leaves the old one, then arrives
      // on the new one like on any broker.
      url = next.url;
      for (const watcher of watchers) watcher(["b1"]);
      await until(() => next.count(REQUEST) === 1, 3000);
      await until(() => old.count("DISCONNECT") === 2);
      expect(old.packets().slice(7)).toEqual([DISCONNECTED, "DISCONNECT"]);
      expect(next.packets().slice(0, 4)).toEqual(["CONNECT", `SUBSCRIBE ${variable}`, CONNECTED, REQUEST]);
      await renewed(next);
      expect(next.packets()[4]).toBe(withWill);

      performer.dispose();
      await until(() => next.count("DISCONNECT") === 2);
      expect(next.packets().slice(7)).toEqual([DISCONNECTED, "DISCONNECT"]);
      // Every link ended with a DISCONNECT: neither broker published a will.
      expect([...old.wills(), ...next.wills()]).toEqual([]);
    },
    10_000,
  );

  // Bridge ID `alpha` on broker `b1`, as the announce table names them.
  const VARIABLE = "microflow/alpha/figma/variable/1-2";
  const STATUS_TOPIC = "microflow/alpha/app/status";
  const CONNECTED = `PUBLISH ${STATUS_TOPIC} connected retain`;
  const REQUEST = "PUBLISH microflow/alpha/app/variables/request ";
  const DISCONNECTED = `PUBLISH ${STATUS_TOPIC} disconnected retain`;
  const WITH_WILL = `CONNECT will ${STATUS_TOPIC} disconnected retain`;

  /** A performer whose flow wants design variable `alpha` on `mosquitto`. */
  function announcing(mosquitto: ScriptedBroker) {
    const delivered: string[] = [];
    const performer = new CloudPerformer(
      { resolveLlmProvider: () => undefined, resolveBroker: (id) => ({ id, url: mosquitto.url }) },
      () => {},
      (_nodeId, topic, payload) => delivered.push(`${topic} ${new TextDecoder().decode(payload)}`),
      announceFromTable,
    );
    cleanups.unshift(() => performer.dispose());
    performer.reconcile([{ brokerId: "b1", topic: VARIABLE, nodeId: "fig", kind: "topicAware" }]);
    return { performer, delivered };
  }

  test(
    "once announced, the link is renewed to carry the goodbye as its will, with nothing said and nothing delivered twice",
    async () => {
      const mosquitto = broker();
      mosquitto.retain(VARIABLE, "0.5");
      const { delivered } = announcing(mosquitto);

      await until(() => mosquitto.count("DISCONNECT") === 1 && mosquitto.connections() === 1);
      expect(mosquitto.packets().slice(0, 5)).toEqual([
        "CONNECT",
        `SUBSCRIBE ${VARIABLE}`,
        CONNECTED,
        REQUEST,
        WITH_WILL,
      ]);
      expect(mosquitto.packets().slice(5).sort()).toEqual(["DISCONNECT", `SUBSCRIBE ${VARIABLE}`]);
      expect(mosquitto.retained(STATUS_TOPIC)).toBe("connected");
      expect(mosquitto.wills()).toEqual([]);
      // The new link's SUBSCRIBE was answered with the retained value too.
      expect(delivered).toEqual([`${VARIABLE} 0.5`]);
    },
    10_000,
  );

  test(
    "a link that ends without a goodbye leaves `disconnected`; the link that repairs it says Studio is there again",
    async () => {
      const mosquitto = broker();
      announcing(mosquitto);
      await until(() => mosquitto.count("DISCONNECT") === 1 && mosquitto.connections() === 1);

      // The tab crashed, the network went: nobody said goodbye.
      mosquitto.drop();
      await until(() => mosquitto.retained(STATUS_TOPIC) === "disconnected");
      expect(mosquitto.wills()).toEqual([`${STATUS_TOPIC} disconnected retain`]);

      // The client repairs the link by itself, a few seconds later. The new
      // link carries the will, and is told again that Studio is there.
      await until(() => mosquitto.count(REQUEST) === 2, 12_000);
      expect(mosquitto.packets().slice(7)).toEqual([
        WITH_WILL,
        `SUBSCRIBE ${VARIABLE}`,
        CONNECTED,
        REQUEST,
      ]);
      expect(mosquitto.retained(STATUS_TOPIC)).toBe("connected");
    },
    20_000,
  );

  test("a goodbye drops the will: Studio says `disconnected` itself, and the broker says nothing", async () => {
    const mosquitto = broker();
    const { performer } = announcing(mosquitto);
    await until(() => mosquitto.count("DISCONNECT") === 1 && mosquitto.connections() === 1);

    performer.dispose();
    await until(() => mosquitto.count("DISCONNECT") === 2 && mosquitto.connections() === 0);

    expect(mosquitto.packets().slice(7)).toEqual([DISCONNECTED, "DISCONNECT"]);
    expect(mosquitto.wills()).toEqual([]);
    expect(mosquitto.retained(STATUS_TOPIC)).toBe("disconnected");
  });
});
