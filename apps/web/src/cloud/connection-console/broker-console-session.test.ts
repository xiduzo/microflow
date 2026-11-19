// The broker console, driven the way the page drives it: a command string goes
// in, and what comes out is a transport call and a transcript line.
//
// The transport is an in-memory stand-in. Neither real adapter runs without a
// host behind it (Tauri IPC, a WebSocket), and the stand-in can do what only
// the desktop host does: deliver messages nobody on this console asked for.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { settleBrokerSettings, useMqttBrokerStore, type MqttBrokerConfig } from "@/cloud/mqtt-broker";

import {
  createBrokerConsoleSession,
  type BrokerConsoleSession,
  type BrokerMessage,
  type BrokerTransport,
} from "./broker-console-session";
import { completeCommand } from "./completions";

const HOME: MqttBrokerConfig = { id: "home", name: "Home", url: "wss://home.example/mqtt", isDefault: false };
const LAB: MqttBrokerConfig = { id: "lab", name: "Lab", url: "wss://lab.example/mqtt", isDefault: true };

/**
 * A host with one message stream for everything, like the desktop's
 * "mqtt-message" event: `deliver` reaches every open link whatever broker the
 * message names.
 */
function fakeHost() {
  const calls: string[] = [];
  const open = new Set<(message: BrokerMessage) => void>();
  let held: Promise<void> | undefined;
  const host = {
    calls,
    /** While true the broker refuses everything, as a disconnected one does. */
    refusing: false,
    /** Runs while a subscribe is on its way, before the broker's answer is back. */
    whileSubscribing: () => {},
    /**
     * Whether a link is the connection itself, as in a browser, and so is tied
     * to the broker's URL. False for a host that keeps the connections, as the
     * desktop app does.
     */
    linkIsConnection: true,
    /**
     * Keep the broker's answer to the next subscribe back until the returned
     * function is called, however many commands run in between.
     */
    holdNextSubscribe() {
      let answer = () => {};
      held = new Promise<void>((resolve) => (answer = resolve));
      return answer;
    },
    deliver: (message: BrokerMessage) => {
      for (const onMessage of open) onMessage(message);
    },
    transport: {
      linkKey: (broker) => (host.linkIsConnection ? `${broker.id} ${broker.url}` : broker.id),
      open(broker, onMessage) {
        calls.push(`open ${broker.id} ${broker.url}`);
        open.add(onMessage);
        return {
          subscribe: async (topic) => {
            calls.push(`subscribe ${broker.id} ${topic}`);
            const waiting = held;
            held = undefined;
            host.whileSubscribing();
            await waiting;
            return !host.refusing;
          },
          unsubscribe: async (topic) => {
            calls.push(`unsubscribe ${broker.id} ${topic}`);
            return !host.refusing;
          },
          publish: async (topic, payload) => {
            calls.push(`publish ${broker.id} ${topic} ${payload}`);
            return !host.refusing;
          },
          close: () => {
            calls.push(`close ${broker.id}`);
            open.delete(onMessage);
          },
        };
      },
    } satisfies BrokerTransport,
  };
  return host;
}

/** The transcript as text: kind, then label, then what was said. */
function transcript(session: BrokerConsoleSession): string[] {
  return session
    .getState()
    .lines.map((line) => [line.kind, line.label, line.text].filter(Boolean).join(" "));
}

function start(options: { linkIsConnection?: boolean } = {}) {
  const host = fakeHost();
  host.linkIsConnection = options.linkIsConnection ?? true;
  const tracked: Array<[string, unknown]> = [];
  const session = createBrokerConsoleSession({
    transport: host.transport,
    track: (event, data) => tracked.push([event, data]),
  });
  const close = session.open();
  opened.push(close);
  return { host, session, tracked, close };
}

const opened: Array<() => void> = [];

const store = () => useMqttBrokerStore.getState();

afterEach(() => {
  // A session left open would keep following store edits made by later tests.
  for (const close of opened.splice(0)) close();
  // Ends the settle waits of whatever a test left typed.
  settleBrokerSettings();
});

beforeEach(() => {
  // Copies: the store hands the default flag on by writing to the entry it holds.
  useMqttBrokerStore.setState({ brokers: [{ ...HOME }, { ...LAB }], unsettled: {}, statuses: {} });
});

describe("selection", () => {
  test("starts on the default broker, and holds a link to it once open", () => {
    const { host, session } = start();

    expect(session.getState().selectedId).toBe("lab");
    expect(host.calls).toEqual(["open lab wss://lab.example/mqtt"]);
  });

  test("starts on the first broker when none is the default, and on nothing when there are none", () => {
    useMqttBrokerStore.setState({ brokers: [HOME, { ...LAB, isDefault: false }] });
    expect(start().session.getState().selectedId).toBe("home");

    useMqttBrokerStore.setState({ brokers: [] });
    const { host, session } = start();
    expect(session.getState().selectedId).toBe("");
    expect(host.calls).toEqual([]);
  });

  test("touches the host only between open and close", () => {
    const host = fakeHost();
    const session = createBrokerConsoleSession({ transport: host.transport });
    expect(host.calls).toEqual([]);

    const close = session.open();
    close();
    expect(host.calls).toEqual(["open lab wss://lab.example/mqtt", "close lab"]);
  });

  test("switching broker moves the link and starts an empty transcript", async () => {
    const { host, session } = start();
    await session.run("subscribe test/#");
    host.calls.length = 0;

    session.select("home");

    expect(host.calls).toContain("close lab");
    expect(host.calls.at(-1)).toBe("open home wss://home.example/mqtt");
    expect(session.getState()).toMatchObject({ selectedId: "home", lines: [], subscriptions: [] });
  });

  test("a new URL for the selected broker replaces the link; any other edit leaves it alone", () => {
    const { host } = start();
    host.calls.length = 0;

    store().updateBroker("lab", { name: "Laboratory" });
    store().updateBroker("home", { url: "wss://elsewhere.example/mqtt" });
    settleBrokerSettings();
    store().setStatus("lab", "connected");
    expect(host.calls).toEqual([]);

    store().updateBroker("lab", { url: "wss://lab.example:8081/mqtt" });
    settleBrokerSettings();
    expect(host.calls).toEqual(["close lab", "open lab wss://lab.example:8081/mqtt"]);
  });

  test("the link stays as it is while a URL is typed, and is replaced once when the URL has settled", () => {
    const { host } = start();
    host.calls.length = 0;
    const url = "wss://lab.example:8081/mqtt";

    // What the URL field writes, a keystroke at a time.
    for (let length = 1; length <= url.length; length++) {
      store().updateBroker("lab", { url: url.slice(0, length) });
    }
    expect(host.calls).toEqual([]);

    settleBrokerSettings();
    expect(host.calls).toEqual(["close lab", `open lab ${url}`]);
  });

  test("a command is run on the broker as the form shows it: what is typed settles first", async () => {
    const { host, session } = start();
    host.calls.length = 0;

    store().updateBroker("lab", { url: "wss://lab.example:8081/mqtt" });
    await session.run("subscribe test/#");

    expect(host.calls).toEqual([
      "close lab",
      "open lab wss://lab.example:8081/mqtt",
      "subscribe lab test/#",
    ]);
  });

  test("selecting the broker that is already selected changes nothing", async () => {
    const { host, session } = start();
    await session.run("subscribe test/#");
    host.calls.length = 0;
    const before = session.getState();

    session.select("lab");

    expect(host.calls).toEqual([]);
    expect(session.getState()).toBe(before);
    expect(transcript(session)).toEqual(["sys test/# subscribed"]);
  });

  test("on a host that keeps the connections, the link outlives a URL edit", async () => {
    const { host, session } = start({ linkIsConnection: false });
    await session.run("subscribe test/#");
    host.calls.length = 0;

    store().updateBroker("lab", { url: "mqtt://lab.example:1883" });
    settleBrokerSettings();
    expect(host.calls).toEqual([]);

    // The link is still the broker's: it is the one that goes on a switch.
    session.select("home");
    expect(host.calls).toEqual([
      "unsubscribe lab test/#",
      "close lab",
      "open home wss://home.example/mqtt",
    ]);
  });

  test("deleting the selected broker selects the first one left", () => {
    const { host, session } = start();

    store().deleteBroker("lab");
    expect(session.getState().selectedId).toBe("home");
    expect(host.calls.at(-1)).toBe("open home wss://home.example/mqtt");

    store().deleteBroker("home");
    expect(session.getState().selectedId).toBe("");
  });

  test("tells its observers about every change, and keeps one state object in between", async () => {
    const { session } = start();
    let changes = 0;
    const stop = session.subscribe(() => changes++);

    const before = session.getState();
    expect(session.getState()).toBe(before);
    await session.run("nope");
    expect(changes).toBe(1);
    expect(session.getState()).not.toBe(before);

    stop();
    await session.run("nope");
    expect(changes).toBe(1);
  });
});

describe("commands", () => {
  test("subscribe asks the selected broker and lists the topic as listened to", async () => {
    const { host, session } = start();

    await session.run("subscribe test/#");

    expect(host.calls).toContain("subscribe lab test/#");
    expect(transcript(session)).toEqual(["sys test/# subscribed"]);
    expect(session.getState().subscriptions).toEqual(["test/#"]);
  });

  test("the verb is case-insensitive and has a short form; the topic is taken as typed", async () => {
    const { host, session } = start();

    await session.run("  SUB Test/Topic ");
    await session.run("sub Test/Topic");

    expect(host.calls.filter((call) => call.startsWith("subscribe"))).toEqual([
      "subscribe lab Test/Topic",
      "subscribe lab Test/Topic",
    ]);
    // Subscribing twice is still one subscription.
    expect(session.getState().subscriptions).toEqual(["Test/Topic"]);
  });

  test("unsubscribe stops listening", async () => {
    const { host, session } = start();
    await session.run("subscribe test/#");

    await session.run("unsub test/#");

    expect(host.calls).toContain("unsubscribe lab test/#");
    expect(transcript(session).at(-1)).toBe("sys test/# unsubscribed");
    expect(session.getState().subscriptions).toEqual([]);
  });

  test("publish sends the payload exactly as typed", async () => {
    const { host, session } = start();

    await session.run("publish test/hello hello  wide world");
    await session.run("pub test/empty");

    expect(host.calls).toContain("publish lab test/hello hello  wide world");
    expect(host.calls).toContain("publish lab test/empty ");
    expect(transcript(session)).toEqual(["out test/hello hello  wide world", "out test/empty"]);
  });

  test("a command without its topic says what it needs and calls nothing", async () => {
    const { host, session } = start();
    host.calls.length = 0;

    await session.run("subscribe");
    await session.run("unsubscribe");
    await session.run("publish");

    expect(host.calls).toEqual([]);
    expect(transcript(session)).toEqual([
      "err subscribe needs a topic — try: subscribe test/#",
      "err unsubscribe needs a topic",
      "err publish needs a topic — try: publish test/hello world",
    ]);
  });

  test("a refusing broker turns every command into an error line and changes nothing", async () => {
    const { host, session } = start();
    await session.run("subscribe kept/#");
    host.refusing = true;

    await session.run("subscribe test/#");
    await session.run("unsubscribe kept/#");
    await session.run("publish test/hello world");

    expect(transcript(session).slice(1)).toEqual([
      "err test/# could not subscribe — is the broker connected?",
      "err kept/# could not unsubscribe",
      "err test/hello could not publish — is the broker connected?",
    ]);
    expect(session.getState().subscriptions).toEqual(["kept/#"]);
  });

  test("without a broker, or with one this host cannot reach, commands fail the same way", async () => {
    useMqttBrokerStore.setState({ brokers: [] });
    const none = start().session;
    await none.run("subscribe test/#");
    expect(transcript(none)).toEqual(["err test/# could not subscribe — is the broker connected?"]);

    useMqttBrokerStore.setState({ brokers: [LAB] });
    const unreachable = createBrokerConsoleSession({
      transport: { linkKey: (broker) => broker.id, open: () => undefined },
    });
    opened.push(unreachable.open());
    await unreachable.run("publish test/hello world");
    expect(transcript(unreachable)).toEqual(["err test/hello could not publish — is the broker connected?"]);
  });

  test("clear empties the transcript and keeps the subscriptions", async () => {
    const { session } = start();
    await session.run("subscribe test/#");

    await session.run("clear");

    expect(session.getState()).toMatchObject({ lines: [], subscriptions: ["test/#"] });
  });

  test("? and help answer with the command table", async () => {
    const { session } = start();

    await session.run("?");
    await session.run("help");

    const [first, second] = session.getState().lines;
    expect(first.kind).toBe("sys");
    expect(first.table?.map((command) => command.name)).toEqual([
      "subscribe",
      "unsubscribe",
      "publish",
      "clear",
      "?",
    ]);
    expect(second.table).toEqual(first.table);
  });

  test("anything else is an unknown command, and a blank line is nothing at all", async () => {
    const { session } = start();

    await session.run("nope test/#");
    await session.run("   ");

    expect(transcript(session)).toEqual(['err unknown command "nope" — press ? for the list']);
  });

  test("the transcript keeps the newest 300 lines", async () => {
    const { session } = start();

    for (let index = 0; index < 305; index++) await session.run(`publish count ${index}`);

    const { lines } = session.getState();
    expect(lines).toHaveLength(300);
    expect(lines[0].text).toBe("5");
    expect(lines.at(-1)?.text).toBe("304");
  });
});

describe("inbound messages", () => {
  test("a message on a subscribed topic becomes a transcript line", async () => {
    const { host, session } = start();
    await session.run("subscribe test/#");

    host.deliver({ brokerId: "lab", topic: "test/led", payload: "on" });

    expect(transcript(session).at(-1)).toBe("in test/led on");
  });

  test("flow traffic and other brokers' messages stay out of the transcript", async () => {
    const { host, session } = start();
    await session.run("subscribe test/#");

    // What the desktop host emits for a flow node's subscription: no broker id.
    host.deliver({ brokerId: "", topic: "test/led", payload: "from a flow node" });
    // And for a console subscription made on another broker.
    host.deliver({ brokerId: "home", topic: "test/led", payload: "from another broker" });

    expect(transcript(session)).toEqual(["sys test/# subscribed"]);
  });

  test("only topics the console subscribed to are shown, wildcards included", async () => {
    const { host, session } = start();
    await session.run("subscribe sensors/+/temp");
    await session.run("subscribe test/#");
    await session.run("clear");

    for (const topic of [
      "sensors/kitchen/temp",
      "sensors/kitchen/humidity",
      "sensors/kitchen/oven/temp",
      "test",
      "test/a/b",
      "testing",
      "other/topic",
    ]) {
      host.deliver({ brokerId: "lab", topic, payload: "x" });
    }

    expect(transcript(session)).toEqual(["in sensors/kitchen/temp x", "in test x", "in test/a/b x"]);
  });

  test("a shared subscription shows what the broker delivers on the plain topic", async () => {
    const { host, session } = start();
    await session.run("subscribe $share/group/test/#");
    await session.run("subscribe $queue/sensors/+/temp");
    await session.run("clear");

    // The broker strips the share prefix: members get the message on its own topic.
    for (const topic of [
      "test/led",
      "sensors/kitchen/temp",
      "group/test/led",
      "sensors/kitchen/humidity",
      "$share/group/test/led",
      "other/topic",
    ]) {
      host.deliver({ brokerId: "lab", topic, payload: "x" });
    }

    expect(transcript(session)).toEqual(["in test/led x", "in sensors/kitchen/temp x"]);
  });

  test("a filter that only looks like a shared one is matched as written; a shared one without a filter matches nothing", async () => {
    const { host, session } = start();
    await session.run("subscribe share/group/test/#");
    await session.run("subscribe $share/group");
    await session.run("clear");

    for (const topic of ["test/led", "group/test/led", "share/group/test/led", "$share/group"]) {
      host.deliver({ brokerId: "lab", topic, payload: "x" });
    }

    expect(transcript(session)).toEqual(["in share/group/test/led x"]);
  });

  test("a topic stops being shown once it is unsubscribed", async () => {
    const { host, session } = start();
    await session.run("subscribe test/#");
    await session.run("unsubscribe test/#");

    host.deliver({ brokerId: "lab", topic: "test/led", payload: "late" });

    expect(transcript(session).at(-1)).toBe("sys test/# unsubscribed");
  });

  test("a message that beats the broker's answer to the subscribe is kept", async () => {
    const { host, session } = start();
    // A retained message can arrive before the subscribe call has returned.
    host.whileSubscribing = () => host.deliver({ brokerId: "lab", topic: "test/led", payload: "retained" });

    await session.run("subscribe test/#");

    expect(transcript(session)).toEqual(["in test/led retained", "sys test/# subscribed"]);
  });

  test("a refused subscription shows nothing that arrives afterwards", async () => {
    const { host, session } = start();
    host.refusing = true;
    await session.run("subscribe test/#");

    host.deliver({ brokerId: "lab", topic: "test/led", payload: "x" });

    expect(transcript(session)).toEqual(["err test/# could not subscribe — is the broker connected?"]);
  });
});

describe("letting go of a broker", () => {
  test("switching broker unsubscribes what the console subscribed there", async () => {
    const { host, session } = start();
    await session.run("subscribe test/#");
    await session.run("subscribe sensors/+/temp");
    await session.run("unsubscribe sensors/+/temp");
    await session.run("subscribe other/topic");
    host.calls.length = 0;

    session.select("home");

    expect(host.calls).toEqual([
      "unsubscribe lab test/#",
      "unsubscribe lab other/topic",
      "close lab",
      "open home wss://home.example/mqtt",
    ]);
  });

  test("leaving the page unsubscribes too", async () => {
    const { host, session, close } = start();
    await session.run("subscribe test/#");
    host.calls.length = 0;

    close();

    expect(host.calls).toEqual(["unsubscribe lab test/#", "close lab"]);
    expect(session.getState().subscriptions).toEqual([]);
  });

  test("so does deleting the selected broker", async () => {
    const { host, session } = start();
    await session.run("subscribe test/#");

    store().deleteBroker("lab");

    expect(host.calls).toContain("unsubscribe lab test/#");
    expect(session.getState()).toMatchObject({ selectedId: "home", subscriptions: [] });
  });

  test("a subscribe answered after the switch is undone, and says nothing to the new broker's transcript", async () => {
    const { host, session } = start();
    // The user switches while the subscribe is still on its way.
    host.whileSubscribing = () => {
      host.whileSubscribing = () => {};
      session.select("home");
    };

    await session.run("subscribe test/#");

    expect(host.calls.at(-1)).toBe("unsubscribe lab test/#");
    expect(session.getState()).toMatchObject({ selectedId: "home", lines: [], subscriptions: [] });
  });

  test("a late answer does not undo the same subscription made again since", async () => {
    const { host, session } = start();
    // The first subscribe is still unanswered when the user leaves this broker,
    // comes back to it and subscribes to the same topic again.
    const answer = host.holdNextSubscribe();
    const first = session.run("subscribe test/#");
    session.select("home");
    session.select("lab");
    await session.run("subscribe test/#");
    host.calls.length = 0;

    answer();
    await first;

    expect(host.calls).toEqual([]);
    expect(session.getState().subscriptions).toEqual(["test/#"]);
    expect(transcript(session)).toEqual(["sys test/# subscribed"]);
  });

  test("nor one that is still on its way", async () => {
    const { host, session } = start();
    const answerFirst = host.holdNextSubscribe();
    const first = session.run("subscribe test/#");
    session.select("home");
    session.select("lab");
    const answerSecond = host.holdNextSubscribe();
    const second = session.run("subscribe test/#");
    host.calls.length = 0;

    answerFirst();
    await first;
    answerSecond();
    await second;

    expect(host.calls).toEqual([]);
    expect(session.getState().subscriptions).toEqual(["test/#"]);
  });

  test("a late answer for a topic nothing holds any more is still undone", async () => {
    const { host, session } = start();
    const answer = host.holdNextSubscribe();
    const first = session.run("subscribe test/#");
    session.select("home");
    session.select("lab");
    await session.run("subscribe other/topic");
    host.calls.length = 0;

    answer();
    await first;

    expect(host.calls).toEqual(["unsubscribe lab test/#"]);
    expect(session.getState().subscriptions).toEqual(["other/topic"]);
  });

  test("a subscribe answered after leaving is undone as well", async () => {
    const { host, session, close } = start();
    host.whileSubscribing = close;

    await session.run("subscribe test/#");

    expect(host.calls.at(-1)).toBe("unsubscribe lab test/#");
    expect(session.getState().subscriptions).toEqual([]);
  });
});

describe("completions", () => {
  const offered = (session: BrokerConsoleSession, input: string) =>
    completeCommand(session.getState().commands, input).suggestions.map((entry) => entry.value);

  test("unsubscribe offers what is subscribed; subscribe and publish offer every topic touched, newest first", async () => {
    const { host, session } = start();
    await session.run("subscribe test/#");
    await session.run("publish other/one hi");
    host.deliver({ brokerId: "lab", topic: "test/led", payload: "on" });

    expect(offered(session, "unsubscribe ")).toEqual(["test/#"]);
    expect(offered(session, "publish ")).toEqual(["test/#", "test/led", "other/one"]);
    expect(offered(session, "sub te")).toEqual(["test/#", "test/led"]);
  });
});

describe("analytics", () => {
  test("a broker is reported as added once, and only when it has a URL", () => {
    const { session, tracked } = start();
    session.select(store().addBroker({ name: "New broker", url: "", isDefault: false }));

    session.reportConfigured();
    expect(tracked).toEqual([]);

    // Reported when the URL field is left, which may be before what was typed
    // into it has settled: the report is of the broker as the form shows it.
    store().updateBroker(session.getState().selectedId, { url: "mqtts://broker.example", username: "ada" });
    session.reportConfigured();
    session.reportConfigured();
    expect(tracked).toEqual([["mqtt_broker_added", { scheme: "mqtts", auth: true }]]);

    session.select("home");
    session.reportConfigured();
    expect(tracked.at(-1)).toEqual(["mqtt_broker_added", { scheme: "wss", auth: false }]);
    expect(tracked).toHaveLength(2);
  });
});
