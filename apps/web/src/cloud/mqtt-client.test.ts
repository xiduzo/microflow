// How `BrokerConnections` hands what a broker sends to the subscriptions it
// holds: one delivery per subscription and message, whatever the number of
// copies the broker sends and the filters the message matches, and a retained
// replay only to the subscription that asked for it. The broker is a stub
// client; `mqtt-client.real.test.ts` shows the same against a socket.

import { describe, expect, test } from "bun:test";
import { FakeTimers } from "@/lib/fake-timers";
import {
  BrokerConnections,
  COPY_WINDOW_MS,
  type BrokerConn,
  type MqttClientFactory,
  type MqttClientLike,
} from "./mqtt-client";

/** A connection whose broker accepts every topic at once. */
class StubClient implements MqttClientLike {
  connected = false;
  ended = false;
  readonly published: string[] = [];
  /** `end` throws, as a client whose socket is in a bad state may. */
  failEnd = false;
  private readonly connectListeners: Array<() => void> = [];
  private readonly messageListeners: Array<(topic: string, payload: Uint8Array, retain: boolean) => void> = [];

  on(event: "connect", handler: () => void): void;
  on(event: "message", handler: (topic: string, payload: Uint8Array, retain: boolean) => void): void;
  on(event: "error", handler: (error: unknown) => void): void;
  on(event: string, handler: (...args: never[]) => void): void {
    if (event === "connect") this.connectListeners.push(handler as () => void);
    if (event === "message") this.messageListeners.push(handler as never);
  }
  subscribe(_topic: string, callback: (error?: Error | null) => void): void {
    callback(null);
  }
  unsubscribe(): void {}
  publish(topic: string, message: string): void {
    this.published.push(`${topic} ${message}`);
  }
  end(): void {
    this.ended = true;
    if (this.failEnd) throw new Error("the socket is gone");
  }
  connect(): void {
    this.connected = true;
    for (const listener of this.connectListeners) listener();
  }
  /** The broker sends one copy of a message. */
  deliver(topic: string, text: string, retain = false): void {
    for (const listener of this.messageListeners) listener(topic, new TextEncoder().encode(text), retain);
  }
}

function setup() {
  const clients = new Map<string, StubClient>();
  const factory: MqttClientFactory = {
    create(conn: BrokerConn) {
      const client = new StubClient();
      clients.set(conn.id, client);
      return client;
    },
  };
  const timers = new FakeTimers();
  const made = new BrokerConnections(factory, () => {}, timers);
  const got: string[] = [];
  const subscribe = (filter: string, onMessage?: () => void) =>
    made.subscribe(
      "b",
      filter,
      (topic, payload) => {
        got.push(`${filter} <- ${topic} ${new TextDecoder().decode(payload)}`);
        onMessage?.();
      },
      () => {},
    );
  made.configure("b", { id: "b", url: "wss://b.test" });
  const client = clients.get("b")!;
  client.connect();
  return { made, clients, client, timers, got, subscribe };
}

describe("a message reaches each subscription it matches once", () => {
  test("a broker that sends a copy per matching subscription", () => {
    const { client, got, subscribe } = setup();
    subscribe("sensors/#");
    subscribe("sensors/+/temperature");
    subscribe("sensors/kitchen/temperature");

    // MQTT 3.1.1 §3.3.5: one copy for each of the three matching subscriptions.
    for (let copy = 0; copy < 3; copy++) client.deliver("sensors/kitchen/temperature", "21");

    expect(got).toEqual([
      "sensors/# <- sensors/kitchen/temperature 21",
      "sensors/+/temperature <- sensors/kitchen/temperature 21",
      "sensors/kitchen/temperature <- sensors/kitchen/temperature 21",
    ]);
  });

  test("a broker that sends one copy for them all", () => {
    const { client, got, subscribe, timers } = setup();
    subscribe("sensors/#");
    subscribe("sensors/kitchen");

    client.deliver("sensors/kitchen", "21");
    timers.advance(COPY_WINDOW_MS);
    // The same value again, published anew.
    client.deliver("sensors/kitchen", "21");

    expect(got).toEqual([
      "sensors/# <- sensors/kitchen 21",
      "sensors/kitchen <- sensors/kitchen 21",
      "sensors/# <- sensors/kitchen 21",
      "sensors/kitchen <- sensors/kitchen 21",
    ]);
  });

  test("a message with another payload is never taken for a copy", () => {
    const { client, got, subscribe } = setup();
    subscribe("sensors/#");
    subscribe("sensors/kitchen");

    client.deliver("sensors/kitchen", "21");
    client.deliver("sensors/kitchen", "22");
    client.deliver("sensors/kitchen", "22");

    expect(got).toEqual([
      "sensors/# <- sensors/kitchen 21",
      "sensors/kitchen <- sensors/kitchen 21",
      "sensors/# <- sensors/kitchen 22",
      "sensors/kitchen <- sensors/kitchen 22",
    ]);
  });

  test("on a topic one subscription matches, every message is a new one", () => {
    const { client, got, subscribe } = setup();
    subscribe("sensors/#");
    subscribe("other");

    client.deliver("sensors/kitchen", "21");
    client.deliver("sensors/kitchen", "21");

    expect(got).toEqual(["sensors/# <- sensors/kitchen 21", "sensors/# <- sensors/kitchen 21"]);
  });

  test("the subscriptions a message reaches are the ones there when it arrived", () => {
    const { made, client, got, subscribe } = setup();
    // The first handler lets go of the second subscription and adds a third;
    // the message still reaches the second and not the third.
    subscribe("sensors/#", () => {
      made.unsubscribe("b", "sensors/kitchen");
      subscribe("sensors/+");
    });
    subscribe("sensors/kitchen");

    client.deliver("sensors/kitchen", "21");

    expect(got).toEqual(["sensors/# <- sensors/kitchen 21", "sensors/kitchen <- sensors/kitchen 21"]);
  });
});

describe("a retained message reaches a subscription once", () => {
  test("the replay for a new overlapping subscription reaches only the new one", () => {
    const { client, got, subscribe } = setup();
    subscribe("sensors/kitchen");
    // The broker answers the SUBSCRIBE with the retained value, flagged.
    client.deliver("sensors/kitchen", "21", true);

    subscribe("sensors/#");
    client.deliver("sensors/kitchen", "21", true);
    // A live message, unflagged, is news to both.
    client.deliver("sensors/kitchen", "22");

    expect(got).toEqual([
      "sensors/kitchen <- sensors/kitchen 21",
      "sensors/# <- sensors/kitchen 21",
      "sensors/kitchen <- sensors/kitchen 22",
      "sensors/# <- sensors/kitchen 22",
    ]);
  });

  test("after a reconnect each subscription gets the replay again, once", () => {
    const { client, got, subscribe } = setup();
    subscribe("sensors/kitchen");
    subscribe("sensors/#");
    client.deliver("sensors/kitchen", "21", true);
    client.deliver("sensors/kitchen", "21", true);
    expect(got).toHaveLength(2);

    // The link drops and comes back: every topic is subscribed again, and the
    // broker replays the retained value for each SUBSCRIBE.
    client.connected = false;
    client.connect();
    client.deliver("sensors/kitchen", "21", true);
    client.deliver("sensors/kitchen", "21", true);

    expect(got.slice(2)).toEqual(["sensors/kitchen <- sensors/kitchen 21", "sensors/# <- sensors/kitchen 21"]);
  });
});

describe("publishing", () => {
  test("a topic that is not a topic name is not published, and the connection stays", () => {
    const { made, client } = setup();
    const outcomes = ["microflow/+/app/status", "a/#", ""].map((topic) =>
      made.publish("b", topic, new TextEncoder().encode("x"), { retain: true, whenDown: "keep" }),
    );
    expect(outcomes).toEqual(["invalid", "invalid", "invalid"]);
    expect(made.publish("b", "a/b", new TextEncoder().encode("x"), { retain: false, whenDown: "drop" })).toBe(
      "sent",
    );
    expect(client.published).toEqual(["a/b x"]);
  });
});

describe("disposeAll", () => {
  test("a connection that cannot be closed does not keep the others open", () => {
    const { made, clients } = setup();
    made.configure("c", { id: "c", url: "wss://c.test" });
    clients.get("b")!.failEnd = true;

    expect(() => made.disposeAll()).toThrow("the socket is gone");
    expect(clients.get("c")!.ended).toBe(true);
    // Both are gone: nothing is published on either.
    const payload = new TextEncoder().encode("x");
    expect(made.publish("b", "a", payload, { retain: false, whenDown: "keep" })).toBe("dropped");
    expect(made.publish("c", "a", payload, { retain: false, whenDown: "keep" })).toBe("dropped");
  });
});
