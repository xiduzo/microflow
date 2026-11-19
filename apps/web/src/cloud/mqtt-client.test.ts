// How `BrokerConnections` hands what a broker sends to the subscriptions it
// holds: one delivery per subscription and message, by the subscription
// identifiers the broker tags it with, whatever the number of copies the
// broker sends; a retained replay only to the subscription that asked for it;
// and the wills it leaves with the broker, one link each. The broker is a stub
// client; `mqtt-client.real.test.ts` shows the same against a socket.

import { describe, expect, spyOn, test } from "bun:test";
import { FakeTimers } from "@/lib/fake-timers";
import {
  BrokerConnections,
  CLOSE_GRACE_MS,
  RENEW_MS,
  type BrokerConn,
  type ClientPurpose,
  type MqttClientFactory,
  type MqttClientLike,
  type Will,
} from "./mqtt-client";

/** A connection whose broker accepts every topic at once. It routes like an
 *  MQTT 5 broker: a message is tagged with the subscription identifiers of the
 *  filters it is for, which `deliver` and `deliverEach` work out from what was
 *  subscribed. */
class StubClient implements MqttClientLike {
  connected = false;
  ended = false;
  /** Cut without a DISCONNECT: `end(true)`, or one whose end was not said. */
  cut = false;
  /** A DISCONNECT went out. */
  saidDisconnect = false;
  subscriptionIds = true;
  readonly published: string[] = [];
  /** The filters the broker holds, each with its subscription identifier. */
  readonly filters = new Map<string, number | undefined>();
  /** `end` throws, as a client whose socket is in a bad state may. */
  failEnd = false;
  private readonly connectListeners: Array<() => void> = [];
  private readonly messageListeners: Array<
    (topic: string, payload: Uint8Array, retain: boolean, ids: readonly number[]) => void
  > = [];

  constructor(
    readonly will: Will | undefined,
    readonly purpose: ClientPurpose,
  ) {}

  on(event: "connect", handler: () => void): void;
  on(
    event: "message",
    handler: (topic: string, payload: Uint8Array, retain: boolean, ids: readonly number[]) => void,
  ): void;
  on(event: "error", handler: (error: unknown) => void): void;
  on(event: string, handler: (...args: never[]) => void): void {
    if (event === "connect") this.connectListeners.push(handler as () => void);
    if (event === "message") this.messageListeners.push(handler as never);
  }
  subscribe(topic: string, id: number | undefined, callback: (error?: Error | null) => void): void {
    this.filters.set(topic, id);
    callback(null);
  }
  unsubscribe(topic: string): void {
    this.filters.delete(topic);
  }
  publish(topic: string, message: string): void {
    this.published.push(`${topic} ${message}`);
  }
  end(force = false, done?: () => void): void {
    this.ended = true;
    if (this.failEnd) throw new Error("the socket is gone");
    if (force || !this.connected) {
      this.cut = this.connected;
    } else {
      this.saidDisconnect = true;
      done?.();
    }
    this.connected = false;
  }
  connect(): void {
    this.connected = true;
    for (const listener of this.connectListeners) listener();
  }
  /** The identifiers of the filters `topic` is for, by `filters` (the test
   *  names them: this stub does not match topics). */
  private ids(filters: readonly string[]): number[] {
    return filters.map((filter) => {
      const id = this.filters.get(filter);
      if (id === undefined) throw new Error(`${filter} is not subscribed with an identifier`);
      return id;
    });
  }
  /** The broker sends one copy of a message, tagged for every filter in
   *  `for`, as HiveMQ does. */
  deliver(topic: string, text: string, { for: filters = [], retain = false }: Delivery = {}): void {
    this.send(topic, text, retain, this.ids(filters));
  }
  /** The broker sends one copy of a message per filter in `for`, each tagged
   *  for its filter, as mosquitto 2 and EMQX do. */
  deliverEach(topic: string, text: string, { for: filters = [], retain = false }: Delivery = {}): void {
    for (const id of this.ids(filters)) this.send(topic, text, retain, [id]);
  }
  /** A message tagged with exactly `ids`. */
  send(topic: string, text: string, retain: boolean, ids: readonly number[]): void {
    for (const listener of this.messageListeners) listener(topic, new TextEncoder().encode(text), retain, ids);
  }
}

type Delivery = { for?: readonly string[]; retain?: boolean };

function setup() {
  const links: StubClient[] = [];
  const willLinks: StubClient[] = [];
  const factory: MqttClientFactory = {
    create(_conn: BrokerConn, will: Will | undefined, purpose: ClientPurpose) {
      const client = new StubClient(will, purpose);
      (purpose === "will" ? willLinks : links).push(client);
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
  const client = links[0];
  client.connect();
  return { made, links, willLinks, client, timers, got, subscribe };
}

const KITCHEN = ["sensors/#", "sensors/+/temperature", "sensors/kitchen/temperature"];

describe("a message reaches each subscription it is for once", () => {
  test("every filter is subscribed with an identifier of its own", () => {
    const { client, subscribe } = setup();
    for (const filter of KITCHEN) subscribe(filter);
    const ids = [...client.filters.values()];
    expect(ids.every((id) => typeof id === "number" && id > 0)).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });

  test("a broker that sends a copy per matching subscription", () => {
    const { client, got, subscribe } = setup();
    for (const filter of KITCHEN) subscribe(filter);

    client.deliverEach("sensors/kitchen/temperature", "21", { for: KITCHEN });

    expect(got).toEqual([
      "sensors/# <- sensors/kitchen/temperature 21",
      "sensors/+/temperature <- sensors/kitchen/temperature 21",
      "sensors/kitchen/temperature <- sensors/kitchen/temperature 21",
    ]);
  });

  test("a broker that sends one copy for them all", () => {
    const { client, got, subscribe } = setup();
    for (const filter of KITCHEN) subscribe(filter);

    client.deliver("sensors/kitchen/temperature", "21", { for: KITCHEN });

    expect(got).toEqual([
      "sensors/# <- sensors/kitchen/temperature 21",
      "sensors/+/temperature <- sensors/kitchen/temperature 21",
      "sensors/kitchen/temperature <- sensors/kitchen/temperature 21",
    ]);
  });

  // A copy-window heuristic took the second of these for a copy of the first.
  test("the same payload published twice at once is two messages, in either delivery style", () => {
    for (const style of ["deliver", "deliverEach"] as const) {
      const { client, got, subscribe } = setup();
      subscribe("sensors/#");
      subscribe("sensors/kitchen");
      const both = { for: ["sensors/#", "sensors/kitchen"] };

      client[style]("sensors/kitchen", "21", both);
      client[style]("sensors/kitchen", "21", both);

      const once = ["sensors/# <- sensors/kitchen 21", "sensors/kitchen <- sensors/kitchen 21"];
      expect(got.toSorted()).toEqual([...once, ...once].toSorted());
    }
  });

  test("a message goes only to the filters it names, not to every filter that matches its topic", () => {
    const { client, got, subscribe } = setup();
    subscribe("sensors/#");
    subscribe("sensors/kitchen");

    // A broker's answer to the SUBSCRIBE for `sensors/#` alone.
    client.deliver("sensors/kitchen", "21", { for: ["sensors/#"] });

    expect(got).toEqual(["sensors/# <- sensors/kitchen 21"]);
  });

  test("an identifier named twice is one delivery, and one of a filter let go of reaches nobody", () => {
    const { made, client, got, subscribe } = setup();
    subscribe("sensors/#");
    subscribe("sensors/kitchen");
    const gone = client.filters.get("sensors/kitchen")!;
    const kept = client.filters.get("sensors/#")!;
    made.unsubscribe("b", "sensors/kitchen");

    client.send("sensors/kitchen", "21", false, [kept, kept, gone]);

    expect(got).toEqual(["sensors/# <- sensors/kitchen 21"]);
  });

  test("an identifier whose filter does not match the topic is not delivered there, and that is said once", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { client, got, subscribe } = setup();
      subscribe("doors/#");
      const doors = client.filters.get("doors/#")!;

      client.send("sensors/kitchen", "21", false, [doors]);
      client.send("sensors/kitchen", "22", false, [doors]);

      expect(got).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a message without an identifier goes to every filter that matches its topic, and that is said once", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { client, got, subscribe } = setup();
      subscribe("sensors/#");
      subscribe("sensors/kitchen");
      subscribe("doors/#");

      client.send("sensors/kitchen", "21", false, []);
      client.send("sensors/kitchen", "22", false, []);

      expect(got).toEqual([
        "sensors/# <- sensors/kitchen 21",
        "sensors/kitchen <- sensors/kitchen 21",
        "sensors/# <- sensors/kitchen 22",
        "sensors/kitchen <- sensors/kitchen 22",
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a broker that takes no identifiers is asked for none", () => {
    const { links, made, got } = setup();
    made.configure("b", { id: "b", url: "wss://other.test" });
    const client = links[1];
    client.subscriptionIds = false;
    client.connect();
    made.subscribe("b", "sensors/#", (topic) => got.push(topic), () => {});

    expect([...client.filters]).toEqual([["sensors/#", undefined]]);
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

    client.deliver("sensors/kitchen", "21", { for: ["sensors/#", "sensors/kitchen"] });

    expect(got).toEqual(["sensors/# <- sensors/kitchen 21", "sensors/kitchen <- sensors/kitchen 21"]);
  });

  test("a filter keeps its identifier over a reconnect and a will renewal", () => {
    const { made, links, client, subscribe } = setup();
    subscribe("sensors/#");
    subscribe("sensors/kitchen");
    const before = [...client.filters];

    client.connected = false;
    client.filters.clear();
    client.connect();
    expect([...client.filters]).toEqual(before);

    made.setWills("b", [{ topic: "app/status", payload: "gone", retain: true }]);
    const renewed = links[1];
    renewed.connect();
    expect([...renewed.filters]).toEqual(before);
  });
});

describe("a retained message reaches a subscription once", () => {
  test("the replay for a new overlapping subscription reaches only the new one", () => {
    const { client, got, subscribe } = setup();
    subscribe("sensors/kitchen");
    // The broker answers the SUBSCRIBE with the retained value, flagged.
    client.deliver("sensors/kitchen", "21", { for: ["sensors/kitchen"], retain: true });

    subscribe("sensors/#");
    client.deliver("sensors/kitchen", "21", { for: ["sensors/#"], retain: true });
    // A live message, unflagged, is news to both.
    client.deliver("sensors/kitchen", "22", { for: ["sensors/kitchen", "sensors/#"] });

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
    client.deliverEach("sensors/kitchen", "21", { for: ["sensors/kitchen", "sensors/#"], retain: true });
    expect(got).toHaveLength(2);

    // The link drops and comes back: every topic is subscribed again, and the
    // broker replays the retained value for each SUBSCRIBE.
    client.connected = false;
    client.connect();
    client.deliverEach("sensors/kitchen", "21", { for: ["sensors/kitchen", "sensors/#"], retain: true });

    expect(got.slice(2)).toEqual(["sensors/kitchen <- sensors/kitchen 21", "sensors/# <- sensors/kitchen 21"]);
  });
});

/** The goodbye of Bridge ID `uid`, as the announce policy gives it. */
const gone = (uid: string): Will => ({ topic: `microflow/${uid}/app/status`, payload: "disconnected", retain: true });

describe("every will has a link that carries it", () => {
  test("the first will is the link's; each further one gets a will link of its own, which does nothing else", () => {
    const { made, links, willLinks, subscribe } = setup();
    subscribe("sensors/#");

    made.setWills("b", [gone("a"), gone("b"), gone("c")]);

    expect(links[1].will).toEqual(gone("a"));
    expect(willLinks.map((link) => link.will)).toEqual([gone("b"), gone("c")]);
    for (const link of willLinks) link.connect();
    links[1].connect();
    expect(willLinks.every((link) => link.filters.size === 0 && link.published.length === 0)).toBe(true);
    // A will link is not the connection's link: its number does not change.
    expect(made.link("b")).toBe(1);
  });

  test("a will no CONNECT can carry, and a second will on one topic, get no link", () => {
    const { made, links, willLinks } = setup();
    made.setWills("b", [gone("a"), { ...gone("b"), topic: "microflow/+/app/status" }, gone("a"), gone("c")]);
    expect(links[1].will).toEqual(gone("a"));
    expect(willLinks.map((link) => link.will)).toEqual([gone("c")]);
  });

  test("a will link whose Bridge ID leaves says DISCONNECT while the connection's link is up", () => {
    const { made, willLinks } = setup();
    made.setWills("b", [gone("a"), gone("b")]);
    const [b] = willLinks;
    b.connect();

    made.setWills("b", [gone("a")]);

    expect(b.saidDisconnect).toBe(true);
    expect(b.cut).toBe(false);
  });

  test("a will link whose Bridge ID leaves while the connection's link is down is cut, so the broker says the goodbye", () => {
    const { made, willLinks, client } = setup();
    made.setWills("b", [gone("a"), gone("b")]);
    const [b] = willLinks;
    b.connect();

    client.connected = false;
    made.setWills("b", [gone("a")]);

    expect(b.saidDisconnect).toBe(false);
    expect(b.cut).toBe(true);
  });

  test("a changed will on a will link's topic is carried by a new will link, make before break", () => {
    const { made, willLinks } = setup();
    made.setWills("b", [gone("a"), gone("b")]);
    const [old] = willLinks;
    old.connect();

    made.setWills("b", [gone("a"), { ...gone("b"), payload: "away" }]);
    const renewed = willLinks[1];
    expect(renewed.will).toEqual({ ...gone("b"), payload: "away" });
    expect(old.ended).toBe(false);

    renewed.connect();
    expect(old.saidDisconnect).toBe(true);
  });

  test("a will link renewal that does not connect in time is closed; the will link in use keeps its will", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { made, willLinks, timers } = setup();
      made.setWills("b", [gone("a"), gone("b")]);
      const [old] = willLinks;
      old.connect();
      made.setWills("b", [gone("a"), { ...gone("b"), payload: "away" }]);
      const late = willLinks[1];

      timers.advance(RENEW_MS);
      expect(late.ended).toBe(true);
      expect(old.ended).toBe(false);

      // Once it is repaired, it is renewed again.
      old.connected = false;
      old.connect();
      expect(willLinks).toHaveLength(3);
      expect(willLinks[2].will).toEqual({ ...gone("b"), payload: "away" });
    } finally {
      warn.mockRestore();
    }
  });

  test("a will link that becomes the first is kept until the connection's link carries it", () => {
    const { made, links, willLinks } = setup();
    made.setWills("b", [gone("a"), gone("b")]);
    const main = links[1];
    main.connect();
    const [b] = willLinks;
    b.connect();

    // `a` leaves: `b`'s goodbye is the first now.
    made.setWills("b", [gone("b")]);
    expect(b.ended).toBe(false);
    const renewed = links[2];
    expect(renewed.will).toEqual(gone("b"));

    renewed.connect();
    expect(b.saidDisconnect).toBe(true);
    expect(main.saidDisconnect).toBe(true);
  });

  test("a connection closed on purpose says DISCONNECT on its will links after its own", () => {
    const order: string[] = [];
    const willLinks: StubClient[] = [];
    const links: StubClient[] = [];
    const factory: MqttClientFactory = {
      create(_conn, will, purpose) {
        const client = new StubClient(will, purpose);
        (purpose === "will" ? willLinks : links).push(client);
        return client;
      },
    };
    const timers = new FakeTimers();
    const made = new BrokerConnections(factory, () => order.push("goodbyes"), timers);
    made.configure("b", { id: "b", url: "wss://b.test" });
    links[0].connect();
    made.setWills("b", [gone("a"), gone("b")]);
    willLinks[0].connect();
    // The connection's link waits for an answer before its DISCONNECT.
    const main = links[0];
    let finish: (() => void) | undefined;
    main.end = (force = false, done) => {
      if (force) return;
      finish = () => {
        order.push("link DISCONNECT");
        done?.();
      };
    };
    const willLink = willLinks[0];
    const end = willLink.end.bind(willLink);
    willLink.end = (force, done) => {
      order.push(force ? "will link cut" : "will link DISCONNECT");
      end(force, done);
    };

    made.configure("b", undefined);
    expect(order).toEqual(["goodbyes"]);
    finish?.();
    expect(order).toEqual(["goodbyes", "link DISCONNECT", "will link DISCONNECT"]);
  });

  test("a connection whose link is cut cuts its will links, so the broker says their goodbyes", () => {
    const { made, links, willLinks, timers } = setup();
    made.setWills("b", [gone("a"), gone("b")]);
    const [b] = willLinks;
    b.connect();
    // The broker never answers: the link waits for it.
    links[0].end = (force = false) => {
      if (force) links[0].cut = true;
    };

    made.configure("b", undefined);
    expect(b.ended).toBe(false);
    timers.advance(CLOSE_GRACE_MS);
    expect(links[0].cut).toBe(true);
    expect(b.cut).toBe(true);
  });

  test("a connection closed while its link is down cuts its will links", () => {
    const { made, client, willLinks } = setup();
    made.setWills("b", [gone("a"), gone("b")]);
    const [b] = willLinks;
    b.connect();

    client.connected = false;
    made.configure("b", undefined);

    expect(b.cut).toBe(true);
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
    const { made, links } = setup();
    made.configure("c", { id: "c", url: "wss://c.test" });
    links[0].failEnd = true;

    expect(() => made.disposeAll()).toThrow("the socket is gone");
    expect(links[1].ended).toBe(true);
    // Both are gone: nothing is published on either.
    const payload = new TextEncoder().encode("x");
    expect(made.publish("b", "a", payload, { retain: false, whenDown: "keep" })).toBe("dropped");
    expect(made.publish("c", "a", payload, { retain: false, whenDown: "keep" })).toBe("dropped");
  });
});
