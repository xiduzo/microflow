import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fixture from "../fixtures/protocol.json";
import type { BridgeSnapshotEntry } from "./bridge";
import type { BrokerConnection, ConnectionStatus } from "./broker";
import { parseBrokerUrl } from "./broker-url";
import { mqttBroker } from "./mqtt-broker";
import { startPacketBroker, until } from "./packet-broker";
import { PRESENCE } from "./protocol";
import type { PluginMessage } from "./rpc";
import { createSandboxBridge } from "./sandbox";
import { type PluginBridgeSession, createPluginBridgeSession } from "./session";

/** mqtt.js waits this long before it reconnects. */
const RECONNECT_MS = 1000;

const STATUS = fixture.topics.find(({ fn, args }) => fn === "status" && args[1] === "figma")!.topic;
const WILL = { topic: STATUS, payload: PRESENCE.disconnected, retain: true, qos: 2 } as const;

let broker: ReturnType<typeof startPacketBroker>;
const connections: BrokerConnection[] = [];
const sessions: PluginBridgeSession[] = [];

beforeEach(() => {
  broker = startPacketBroker();
});

afterEach(() => {
  for (const connection of connections.splice(0)) connection.end();
  for (const session of sessions.splice(0)) session.dispose();
  broker.stop();
});

function brokerUrl() {
  const parsed = parseBrokerUrl(broker.url);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.url;
}

/** Open a connection through the adapter, as the client `plugin`. */
function connect(login: { username?: string; password?: string } = {}) {
  const statuses: ConnectionStatus[] = [];
  const connection = mqttBroker({
    url: brokerUrl(),
    clientId: "plugin",
    ...login,
    will: WILL,
    onStatus: (status) => statuses.push(status),
  });
  connections.push(connection);
  const packets = () => broker.packets("plugin");
  return { connection, statuses, packets, up: () => until(() => statuses.at(-1) === "connected") };
}

describe("the mqtt.js adapter, on the wire", () => {
  test("sends the credentials and the last will with CONNECT", async () => {
    const plugin = connect({ username: "sam", password: "secret" });
    await plugin.up();

    expect(plugin.packets()).toEqual([`CONNECT login=sam:secret will=${STATUS}|disconnected|retain qos2`]);
    expect(plugin.statuses).toEqual(["connected"]);
  });

  test("subscribes in one packet to what was asked before the connection came up", async () => {
    const plugin = connect();
    plugin.connection.subscribe("microflow/a/+/status", () => {});
    plugin.connection.subscribe("microflow/a/+/variable/+/set", () => {});
    await plugin.up();
    await until(() => plugin.packets().length === 2);

    expect(plugin.packets()[1]).toBe("SUBSCRIBE microflow/a/+/status microflow/a/+/variable/+/set");
  });

  test("publishes with the retain flag and the QoS it was given, and nothing while it is down", async () => {
    const plugin = connect();
    plugin.connection.publish("microflow/a/figma/variable/1-2", "too early");
    await plugin.up();

    plugin.connection.publish(STATUS, PRESENCE.connected, { retain: true, qos: 2 });
    plugin.connection.publish("microflow/a/figma/variables", "{}", { retain: true });
    plugin.connection.publish("microflow/a/figma/variable/1-2", "0.5");
    await until(() => plugin.packets().length === 4);

    expect(plugin.packets().slice(1)).toEqual([
      `PUBLISH ${STATUS} connected retain qos2`,
      "PUBLISH microflow/a/figma/variables {} retain qos0",
      "PUBLISH microflow/a/figma/variable/1-2 0.5 qos0",
    ]);
  });

  test("never sends a publish on a topic that is not a topic name, and keeps the connection", async () => {
    const plugin = connect();
    await plugin.up();

    for (const topic of ["microflow/a/figma/variable/+", "microflow/a/#", "", "a\u0000b"]) {
      plugin.connection.publish(topic, "0.5");
    }
    plugin.connection.publish("microflow/a/figma/variable/1-2", "0.5");
    await until(() => plugin.packets().length === 2);

    expect(plugin.packets().slice(1)).toEqual(["PUBLISH microflow/a/figma/variable/1-2 0.5 qos0"]);
    expect(plugin.statuses).toEqual(["connected"]);
  });

  test("delivers to every subscriber of a filter, and unsubscribes when the last one ends", async () => {
    const plugin = connect();
    await plugin.up();
    const first: string[] = [];
    const second: string[] = [];
    const endFirst = plugin.connection.subscribe("microflow/a/#", (topic, payload) =>
      first.push(`${topic}=${payload}`),
    );
    const endSecond = plugin.connection.subscribe("microflow/a/#", (topic, payload) =>
      second.push(`${topic}=${payload}`),
    );
    await until(() => plugin.packets().length === 2);

    broker.publish("microflow/a/x", "1");
    await until(() => second.length === 1);
    endFirst();
    broker.publish("microflow/a/x", "2");
    await until(() => second.length === 2);
    endSecond();
    await until(() => plugin.packets().length === 3);

    expect(first).toEqual(["microflow/a/x=1"]);
    expect(second).toEqual(["microflow/a/x=1", "microflow/a/x=2"]);
    expect(plugin.packets().slice(1)).toEqual(["SUBSCRIBE microflow/a/#", "UNSUBSCRIBE microflow/a/#"]);
  });

  test(
    "after a drop it reports the outage, reconnects and subscribes again",
    async () => {
      const plugin = connect();
      const received: string[] = [];
      plugin.connection.subscribe("microflow/a/x", (_topic, payload) => received.push(payload));
      plugin.connection.subscribe("microflow/a/y", () => {});
      await plugin.up();
      await until(() => plugin.packets().length === 2);

      broker.drop("plugin");
      await until(() => plugin.statuses.includes("disconnected"));
      await until(() => broker.retained(STATUS) === PRESENCE.disconnected);
      await plugin.up();
      await until(() => plugin.packets().length === 5);

      expect(plugin.packets().slice(2)).toEqual([
        "CLOSE",
        `CONNECT will=${STATUS}|disconnected|retain qos2`,
        "SUBSCRIBE microflow/a/x microflow/a/y",
      ]);
      expect(plugin.statuses.filter((status) => status !== "disconnected")).toEqual([
        "connected",
        "connecting",
        "connected",
      ]);
      broker.publish("microflow/a/x", "after");
      await until(() => received.length === 1);
      expect(received).toEqual(["after"]);
    },
    RECONNECT_MS + 5000,
  );

  test("end drops the connection without a goodbye, and the adapter goes quiet", async () => {
    const plugin = connect();
    const endSubscription = plugin.connection.subscribe("microflow/a/x", () => {});
    await plugin.up();
    await until(() => plugin.packets().length === 2);

    plugin.connection.end();
    plugin.connection.publish(STATUS, PRESENCE.connected, { retain: true, qos: 2 });
    plugin.connection.subscribe("microflow/a/y", () => {});
    endSubscription();
    await until(() => plugin.packets().includes("CLOSE"));

    // No DISCONNECT, so the broker published the last will.
    expect(plugin.packets().slice(2)).toEqual(["CLOSE"]);
    expect(broker.retained(STATUS)).toBe(PRESENCE.disconnected);
    expect(plugin.statuses).toEqual(["connected"]);
  });
});

describe("the plugin bridge session, on the wire", () => {
  const brightness: BridgeSnapshotEntry = {
    variable: { id: "VariableID:1:2", name: "brightness", resolvedType: "FLOAT" },
    value: 0.5,
  };
  const CLIENT = "microflow_figma_swift_fox_";
  const connectSequence = [
    `CONNECT will=${STATUS}|disconnected|retain qos2`,
    "SUBSCRIBE microflow/swift_fox/+/status",
    `PUBLISH ${STATUS} connected retain qos2`,
    "SUBSCRIBE microflow/swift_fox/+/variable/+/set",
    "SUBSCRIBE microflow/swift_fox/+/variables/request",
    `PUBLISH microflow/swift_fox/figma/variables ${JSON.stringify({ "VariableID:1:2": brightness.variable })} retain qos0`,
    "PUBLISH microflow/swift_fox/figma/variable/1-2 0.5 qos0",
  ];
  const REQUEST = "microflow/swift_fox/app/variables/request";
  const answer = [
    `PUBLISH microflow/swift_fox/app/variables/response ${JSON.stringify({ "VariableID:1:2": brightness.variable })} qos0`,
    "PUBLISH microflow/swift_fox/app/variable/1-2 0.5 qos0",
  ];

  /** A session with the default broker adapter, over a sandbox that holds one variable. */
  function openPlugin() {
    const toUi = new Set<(message: PluginMessage) => void>();
    const sandbox = createSandboxBridge(
      { readSnapshot: () => [brightness], writeValue: () => null },
      {
        send: (message) => {
          for (const listener of toUi) listener(message);
        },
        reportError: () => {},
      },
    );
    const session = createPluginBridgeSession({
      tool: "figma",
      sandbox: {
        send: (message) => sandbox.dispatch(message),
        listen: (onMessage) => {
          toUi.add(onMessage);
          return () => toUi.delete(onMessage);
        },
      },
      storage: {
        load: async () => ({ state: { mqttConfig: { url: broker.url, uniqueId: "swift_fox" } } }),
        save: () => {},
      },
    });
    sessions.push(session);
    return session;
  }

  test(
    "connects and reconnects with one packet sequence, announcing itself once each time",
    async () => {
      // The last will of an earlier plugin window is still retained.
      broker.publish(STATUS, PRESENCE.disconnected, { retain: true });

      const session = openPlugin();
      await until(() => broker.packets(CLIENT).length >= connectSequence.length);
      // Studio's request is answered after everything the retained will could have caused.
      broker.publish(REQUEST, "");
      await until(() => broker.packets(CLIENT).includes(answer.at(-1)!));
      expect(broker.packets(CLIENT)).toEqual([...connectSequence, ...answer]);
      expect(broker.retained(STATUS)).toBe(PRESENCE.connected);
      expect(session.getState().connection).toBe("connected");

      broker.drop(CLIENT);
      await until(() => broker.retained(STATUS) === PRESENCE.disconnected);
      const before = connectSequence.length + answer.length + 1;
      await until(() => broker.packets(CLIENT).length >= before + connectSequence.length);
      broker.publish(REQUEST, "");
      await until(() => broker.packets(CLIENT).slice(before).includes(answer.at(-1)!));
      expect(broker.packets(CLIENT).slice(before - 1)).toEqual(["CLOSE", ...connectSequence, ...answer]);
      expect(broker.retained(STATUS)).toBe(PRESENCE.connected);
    },
    RECONNECT_MS + 5000,
  );
});
