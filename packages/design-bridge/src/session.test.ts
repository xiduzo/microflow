import { afterEach, describe, expect, test } from "bun:test";
import fixture from "../fixtures/protocol.json";
import type { BridgeSnapshotEntry } from "./bridge";
import { type MemoryBroker, createMemoryBroker } from "./memory-broker";
import { type BridgeValue, type DesignTool, PRESENCE } from "./protocol";
import { MSG, type PluginMessage, type UiTransport } from "./rpc";
import { createSandboxBridge } from "./sandbox";
import {
  type BridgeSettings,
  DEFAULT_BROKER_URL,
  POLL_INTERVAL_MS,
  type PluginBridgeSession,
  createPluginBridgeSession,
  settingsProblems,
} from "./session";

/** The topic the shared fixture gives for a builder call, so these tests and Rust agree on it. */
function fixtureTopic(fn: string, ...args: string[]): string {
  const found = fixture.topics.find(
    (entry) => entry.fn === fn && JSON.stringify(entry.args) === JSON.stringify(args),
  );
  if (!found) throw new Error(`the fixture has no ${fn}(${args.join(", ")}) topic`);
  return found.topic;
}

const UID = "swift_fox";
const FIGMA_STATUS = fixtureTopic("status", UID, "figma");
const STUDIO_STATUS = fixtureTopic("status", UID, "app");
const BRIGHTNESS_VALUE = fixtureTopic("value", UID, "figma", "1-2");
const BRIGHTNESS_SET = fixtureTopic("set", UID, "1-2");
const REQUEST = fixtureTopic("request", UID);
const BROKER = "wss://broker.test:8081/mqtt";

const brightness: BridgeSnapshotEntry = {
  variable: { id: "VariableID:1:2", name: "brightness", resolvedType: "FLOAT" },
  value: 0.5,
};

const settings = (bridgeId = UID, extra: Partial<BridgeSettings> = {}): BridgeSettings => ({
  url: BROKER,
  bridgeId,
  ...extra,
});

/** What an installed plugin holds in its storage. */
const stored = (uniqueId = UID, url = BROKER) => ({ state: { mqttConfig: { url, uniqueId } } });

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const sessions: PluginBridgeSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

/**
 * A plugin window: the session, wired to a sandbox (the shared routing over a
 * design file in memory), a settings storage and the in-memory broker, with
 * Studio as a second client on that broker.
 */
function openPlugin(
  options: {
    tool?: DesignTool;
    stored?: unknown;
    storageRefuses?: boolean;
    sandboxAsleep?: boolean;
    broker?: MemoryBroker;
  } = {},
) {
  const broker = options.broker ?? createMemoryBroker();
  const design = {
    entries: [brightness],
    writes: [] as Array<{ id: string; value: BridgeValue }>,
  };
  const saved: unknown[] = [];
  const invalid: string[] = [];
  let loads = 0;
  let snapshotRequests = 0;

  const toUi = new Set<(message: PluginMessage) => void>();
  const sandbox = createSandboxBridge(
    {
      readSnapshot: () => design.entries,
      writeValue: (id, value) => {
        design.writes.push({ id, value });
        return null;
      },
    },
    {
      send: (message) => {
        for (const listener of toUi) listener(message);
      },
      reportError: () => {},
    },
  );
  let asleep = options.sandboxAsleep ?? false;
  const unheard: PluginMessage[] = [];
  const transport: UiTransport = {
    send(message) {
      if (message.type === MSG.GET_VARIABLES) snapshotRequests++;
      if (asleep) unheard.push(message);
      else sandbox.dispatch(message);
    },
    listen(onMessage) {
      toUi.add(onMessage);
      return () => toUi.delete(onMessage);
    },
  };

  const session = createPluginBridgeSession({
    tool: options.tool ?? "figma",
    sandbox: transport,
    storage: {
      load: async () => {
        loads++;
        return options.stored;
      },
      save: (value) => {
        if (options.storageRefuses) throw new Error("storage denied");
        saved.push(value);
      },
    },
    onInvalid: (variable, payload) => invalid.push(`${variable.name}:${payload}`),
    broker: broker.connector,
  });
  sessions.push(session);

  const studio = broker.client();
  studio.subscribe("microflow/#", () => {});

  return {
    session,
    broker,
    studio,
    design,
    saved,
    invalid,
    state: () => session.getState(),
    loads: () => loads,
    snapshotRequests: () => snapshotRequests,
    /** The design file changed and the sandbox says so, as Penpot does on save. */
    pushSnapshot: () => sandbox.pushSnapshot(),
    wakeSandbox() {
      asleep = false;
      for (const message of unheard.splice(0)) sandbox.dispatch(message);
    },
  };
}

describe("settings", () => {
  test("without stored settings there is no connection", async () => {
    const plugin = openPlugin();
    await tick();

    expect(plugin.state().settings).toBeNull();
    expect(plugin.state().connection).toBeUndefined();
    expect(plugin.broker.connections()).toEqual([]);
  });

  test("connects with the stored settings once the sandbox has answered the hello", async () => {
    const plugin = openPlugin({ stored: stored(), sandboxAsleep: true });
    await tick();
    expect(plugin.loads()).toBe(0);
    expect(plugin.state().connection).toBeUndefined();

    plugin.wakeSandbox();
    await tick();
    expect(plugin.state().settings).toEqual({ url: BROKER, bridgeId: UID });
    expect(plugin.state().connection).toBe("connected");
    expect(plugin.broker.connections()).toMatchObject([
      { url: { protocol: "wss", host: "broker.test", port: 8081, path: "/mqtt" }, online: true },
    ]);
  });

  test("reads settings stored as JSON text", async () => {
    const plugin = openPlugin({ tool: "penpot", stored: JSON.stringify(stored()) });
    await tick();

    expect(plugin.state().settings).toEqual({ url: BROKER, bridgeId: UID });
    expect(plugin.broker.retained(fixtureTopic("variables", UID, "penpot"))).toBe(
      JSON.stringify({ [brightness.variable.id]: brightness.variable }),
    );
  });

  test("rewrites the first default broker, which has no WebSocket listener on its default port", async () => {
    const plugin = openPlugin({ stored: stored(UID, "test.mosquitto.org") });
    await tick();

    expect(plugin.state().settings?.url).toBe(DEFAULT_BROKER_URL);
    expect(plugin.broker.connections()).toMatchObject([
      { url: { protocol: "wss", host: "test.mosquitto.org", port: 8081, path: "/mqtt" } },
    ]);
  });

  test("shows a stored Bridge ID that an older rule allowed, with what is wrong, and does not connect", async () => {
    // Letters only, as the first rule asked, but longer than the 64 characters of today's rule.
    const legacyId = "bridge_between_my_figma_file_and_the_prototype_on_my_desk_at_the_studio";
    const plugin = openPlugin({ stored: stored(legacyId) });
    await tick();

    expect(plugin.state().settings).toEqual({ url: BROKER, bridgeId: legacyId });
    expect(plugin.state().settingsErrors).toEqual({ bridgeId: "Use at most 64 characters" });
    expect(settingsProblems(plugin.state().settingsErrors)).toEqual([
      "Bridge ID: Use at most 64 characters",
    ]);
    expect(plugin.state().connection).toBe("disconnected");
    expect(plugin.state().entries).toEqual([{ ...brightness, topics: null }]);
    expect(plugin.broker.connections()).toEqual([]);

    expect(plugin.session.saveSettings(settings())).toEqual({ ok: true, stored: true });
    await tick();
    expect(plugin.state().settingsErrors).toBeNull();
    expect(settingsProblems(plugin.state().settingsErrors)).toEqual([]);
    expect(plugin.state().connection).toBe("connected");
  });

  test("shows a stored broker URL it cannot connect with, with what is wrong", async () => {
    const plugin = openPlugin({ stored: stored(UID, "not a broker") });
    await tick();

    expect(plugin.state().settings).toEqual({ url: "not a broker", bridgeId: UID });
    expect(plugin.state().settingsErrors).toEqual({ url: "Host cannot contain spaces" });
    expect(settingsProblems(plugin.state().settingsErrors)).toEqual([
      "Broker URL: Host cannot contain spaces",
    ]);
    expect(plugin.broker.connections()).toEqual([]);
  });

  test("names every stored setting that is not in use, in the order of the settings page", () => {
    expect(settingsProblems({ url: "Enter a broker URL", bridgeId: "Enter a Bridge ID" })).toEqual([
      "Bridge ID: Enter a Bridge ID",
      "Broker URL: Enter a broker URL",
    ]);
    expect(settingsProblems({ bridgeId: undefined })).toEqual([]);
  });

  test("save connects, and stores the shape an installed plugin reads back", async () => {
    const plugin = openPlugin();
    await tick();

    const result = plugin.session.saveSettings({
      url: ` ${BROKER} `,
      bridgeId: ` ${UID} `,
      username: "sam",
      password: "",
    });
    await tick();

    expect(result).toEqual({ ok: true, stored: true });
    expect(plugin.state().connection).toBe("connected");
    expect(plugin.broker.connections()).toMatchObject([{ username: "sam", password: undefined }]);
    expect(plugin.broker.connections()[0]?.clientId).toStartWith(`microflow_figma_${UID}_`);
    expect(plugin.saved).toEqual([
      { state: { mqttConfig: { url: BROKER, uniqueId: UID, username: "sam" } } },
    ]);

    const reopened = openPlugin({ stored: plugin.saved[0] });
    await tick();
    expect(reopened.state().settings).toEqual({ url: BROKER, bridgeId: UID, username: "sam" });
  });

  test("save rejects a bad URL and a bad Bridge ID, and keeps the connection", async () => {
    const plugin = openPlugin({ stored: stored() });
    await tick();

    const result = plugin.session.saveSettings({ url: "broker", bridgeId: "no spaces" });
    await tick();

    expect(result).toEqual({
      ok: false,
      errors: { url: "Invalid hostname format", bridgeId: "Use only letters, digits, - and _" },
    });
    expect(plugin.saved).toEqual([]);
    expect(plugin.state().settings).toEqual({ url: BROKER, bridgeId: UID });
    expect(plugin.broker.connections()).toMatchObject([{ will: { topic: FIGMA_STATUS }, online: true }]);
  });

  test("settings saved while the storage is read are not replaced by what it held", async () => {
    let release = (_stored: unknown) => {};
    const reading = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const plugin = openPlugin({ stored: reading });

    plugin.session.saveSettings(settings("newer_id"));
    release(stored("stored_id"));
    await tick();

    expect(plugin.state().settings?.bridgeId).toBe("newer_id");
    expect(plugin.broker.connections().map((connection) => connection.will.topic)).toEqual([
      "microflow/newer_id/figma/status",
    ]);
  });

  test("save still connects when the storage refuses the settings", async () => {
    const plugin = openPlugin({ storageRefuses: true });
    await tick();

    expect(plugin.session.saveSettings(settings())).toEqual({ ok: true, stored: false });
    await tick();
    expect(plugin.state().connection).toBe("connected");
  });
});

describe("presence", () => {
  /** How often the plugin was announced as connected on `topic`. */
  const announcements = (broker: MemoryBroker, topic = FIGMA_STATUS) =>
    broker.published.filter(
      (message) => message.topic === topic && message.payload === PRESENCE.connected,
    ).length;

  test("announces the plugin on the status topic and leaves a last will there", async () => {
    const plugin = openPlugin({ stored: stored() });
    expect(plugin.broker.retained(FIGMA_STATUS)).toBeUndefined();
    await tick();

    expect(plugin.broker.retained(FIGMA_STATUS)).toBe(PRESENCE.connected);
    expect(plugin.broker.connections()[0]?.will).toEqual({
      topic: FIGMA_STATUS,
      payload: PRESENCE.disconnected,
      retain: true,
      qos: 2,
    });
  });

  test("the status and the last will are retained at QoS 2, everything else is QoS 0", async () => {
    const plugin = openPlugin({ stored: stored() });
    await tick();
    plugin.studio.publish(REQUEST, "");
    plugin.session.dispose();

    const onStatus = plugin.broker.published.filter((message) => message.topic === FIGMA_STATUS);
    expect(onStatus).toEqual([
      { topic: FIGMA_STATUS, payload: PRESENCE.connected, retain: true, qos: 2 },
      { topic: FIGMA_STATUS, payload: PRESENCE.disconnected, retain: true, qos: 2 },
    ]);
    const rest = plugin.broker.published.filter((message) => message.topic !== FIGMA_STATUS);
    expect(rest.map(({ topic, retain, qos }) => ({ topic, retain, qos }))).toEqual([
      { topic: `microflow/${UID}/figma/variables`, retain: true, qos: 0 },
      { topic: BRIGHTNESS_VALUE, retain: false, qos: 0 },
      { topic: REQUEST, retain: false, qos: 0 },
      { topic: fixtureTopic("response", UID, "app"), retain: false, qos: 0 },
      { topic: fixtureTopic("value", UID, "app", "1-2"), retain: false, qos: 0 },
    ]);
  });

  test("the last will marks the plugin disconnected when its window closes", async () => {
    const plugin = openPlugin({ stored: stored() });
    await tick();

    plugin.session.dispose();
    expect(plugin.broker.retained(FIGMA_STATUS)).toBe(PRESENCE.disconnected);
    expect(plugin.broker.connections()).toEqual([]);
  });

  test("announces once when the last will of an earlier window is still retained", async () => {
    const broker = createMemoryBroker();
    broker.client().publish(FIGMA_STATUS, PRESENCE.disconnected, { retain: true, qos: 2 });
    const plugin = openPlugin({ stored: stored(), broker });
    await tick();

    expect(announcements(broker)).toBe(1);
    expect(broker.retained(FIGMA_STATUS)).toBe(PRESENCE.connected);
    expect(plugin.state().connection).toBe("connected");
  });

  test("announces once per connection: after a drop, and after the same settings are saved again", async () => {
    const plugin = openPlugin({ stored: stored() });
    await tick();
    expect(announcements(plugin.broker)).toBe(1);

    plugin.broker.dropConnections();
    plugin.broker.restoreConnections();
    expect(announcements(plugin.broker)).toBe(2);

    plugin.session.saveSettings(settings());
    await tick();
    expect(announcements(plugin.broker)).toBe(3);
    expect(plugin.broker.retained(FIGMA_STATUS)).toBe(PRESENCE.connected);
  });

  test("announces once more when it is called disconnected after its own announcement came back", async () => {
    const plugin = openPlugin({ stored: stored() });
    await tick();

    plugin.studio.publish(FIGMA_STATUS, PRESENCE.disconnected, { retain: true });
    expect(announcements(plugin.broker)).toBe(2);
    expect(plugin.broker.retained(FIGMA_STATUS)).toBe(PRESENCE.connected);
  });

  test("announces again when the last will of the connection it replaced arrives late", async () => {
    const plugin = openPlugin({ stored: stored() });
    await tick();

    plugin.broker.holdWills();
    plugin.session.saveSettings(settings(UID, { password: "changed" }));
    await tick();
    expect(announcements(plugin.broker)).toBe(2);
    plugin.broker.releaseWills();

    expect(announcements(plugin.broker)).toBe(3);
    expect(plugin.broker.retained(FIGMA_STATUS)).toBe(PRESENCE.connected);
  });

  test("stays announced when a second editor with the same Bridge ID closes", async () => {
    const plugin = openPlugin({ stored: stored() });
    const second = openPlugin({ stored: stored(), broker: plugin.broker });
    await tick();
    expect(announcements(plugin.broker)).toBe(2);

    second.session.dispose();
    expect(announcements(plugin.broker)).toBe(3);
    expect(plugin.broker.retained(FIGMA_STATUS)).toBe(PRESENCE.connected);
  });

  test("follows Studio's status, also when Studio announced itself first", async () => {
    const broker = createMemoryBroker();
    broker.client().publish(STUDIO_STATUS, PRESENCE.connected, { retain: true });
    const plugin = openPlugin({ stored: stored(), broker });
    expect(plugin.state().studio).toBeUndefined();
    await tick();
    expect(plugin.state().studio).toBe("connected");

    plugin.studio.publish(STUDIO_STATUS, PRESENCE.disconnected, { retain: true });
    expect(plugin.state().studio).toBe("disconnected");
  });

  test("another design tool's status is not Studio's", async () => {
    const plugin = openPlugin({ stored: stored() });
    await tick();

    plugin.studio.publish(`microflow/${UID}/penpot/status`, PRESENCE.connected, { retain: true });
    expect(plugin.state().studio).toBeUndefined();
  });
});

describe("bridge", () => {
  test("entries have no topics to copy until there is a Bridge ID", async () => {
    const plugin = openPlugin();
    await tick();
    expect(plugin.state().entries).toEqual([{ ...brightness, topics: null }]);

    plugin.session.saveSettings(settings());
    expect(plugin.state().entries).toEqual([
      { ...brightness, topics: { set: BRIGHTNESS_SET, value: BRIGHTNESS_VALUE } },
    ]);
  });

  test("publishes the variables to Studio and writes what Studio sets into the design file", async () => {
    const plugin = openPlugin({ stored: stored() });
    await tick();

    expect(plugin.studio.received).toContainEqual({ topic: BRIGHTNESS_VALUE, payload: "0.5" });
    expect(plugin.broker.retained(`microflow/${UID}/figma/variables`)).toBe(
      JSON.stringify({ [brightness.variable.id]: brightness.variable }),
    );

    plugin.studio.publish(BRIGHTNESS_SET, "0.9");
    expect(plugin.design.writes).toEqual([{ id: "VariableID:1:2", value: 0.9 }]);

    plugin.studio.publish(BRIGHTNESS_SET, "abc");
    expect(plugin.invalid).toEqual(["brightness:abc"]);
  });

  test("answers Studio's request for the current values", async () => {
    const plugin = openPlugin({ stored: stored() });
    await tick();
    plugin.studio.received.length = 0;

    plugin.studio.publish(REQUEST, "");
    expect(plugin.studio.received).toContainEqual({
      topic: fixtureTopic("value", UID, "app", "1-2"),
      payload: "0.5",
    });
  });

  test("publishes a change the sandbox reports, and tells subscribers once", async () => {
    const plugin = openPlugin({ stored: stored() });
    await tick();
    let notified = 0;
    plugin.session.subscribe(() => notified++);
    plugin.studio.received.length = 0;

    plugin.pushSnapshot();
    expect(notified).toBe(0);
    expect(plugin.studio.received).toEqual([]);

    plugin.design.entries = [{ ...brightness, value: 0.75 }];
    plugin.pushSnapshot();
    plugin.pushSnapshot();
    expect(notified).toBe(1);
    expect(plugin.state().entries[0]?.value).toBe(0.75);
    expect(plugin.studio.received).toEqual([{ topic: BRIGHTNESS_VALUE, payload: "0.75" }]);
  });

  test("polls the sandbox for changes until it is disposed", async () => {
    const plugin = openPlugin({ stored: stored() });
    await tick();

    plugin.design.entries = [{ ...brightness, value: 0.75 }];
    await wait(POLL_INTERVAL_MS + 100);
    expect(plugin.state().entries[0]?.value).toBe(0.75);
    expect(plugin.studio.received.at(-1)).toEqual({ topic: BRIGHTNESS_VALUE, payload: "0.75" });

    plugin.session.dispose();
    const asked = plugin.snapshotRequests();
    await wait(POLL_INTERVAL_MS + 100);
    expect(plugin.snapshotRequests()).toBe(asked);
  });

  test("publishes everything again after the connection dropped and came back", async () => {
    const plugin = openPlugin({ stored: stored() });
    await tick();

    plugin.broker.dropConnections();
    expect(plugin.state().connection).toBe("disconnected");
    expect(plugin.broker.retained(FIGMA_STATUS)).toBe("disconnected");

    // A change while the connection is down is not published, and not lost.
    plugin.design.entries = [{ ...brightness, value: 0.75 }];
    plugin.pushSnapshot();
    plugin.studio.received.length = 0;

    plugin.broker.restoreConnections();
    expect(plugin.state().connection).toBe("connected");
    expect(plugin.broker.retained(FIGMA_STATUS)).toBe("connected");
    expect(plugin.studio.received).toContainEqual({
      topic: `microflow/${UID}/figma/variables`,
      payload: JSON.stringify({ [brightness.variable.id]: brightness.variable }),
    });
    expect(plugin.studio.received).toContainEqual({ topic: BRIGHTNESS_VALUE, payload: "0.75" });

    // The subscriptions survived too.
    plugin.studio.publish(BRIGHTNESS_SET, "0.1");
    expect(plugin.design.writes).toEqual([{ id: "VariableID:1:2", value: 0.1 }]);
  });

  test("a new Bridge ID moves the plugin to the new topics and off the old ones", async () => {
    const plugin = openPlugin({ stored: stored("first_id") });
    await tick();
    plugin.studio.publish("microflow/first_id/app/status", "connected", { retain: true });
    expect(plugin.state().studio).toBe("connected");

    expect(plugin.session.saveSettings(settings("second_id"))).toEqual({ ok: true, stored: true });
    await tick();

    expect(plugin.broker.retained("microflow/first_id/figma/status")).toBe("disconnected");
    expect(plugin.broker.retained("microflow/second_id/figma/status")).toBe("connected");
    expect(plugin.broker.retained("microflow/second_id/figma/variables")).toBe(
      JSON.stringify({ [brightness.variable.id]: brightness.variable }),
    );
    expect(plugin.studio.received).toContainEqual({
      topic: "microflow/second_id/figma/variable/1-2",
      payload: "0.5",
    });
    // Studio on the old Bridge ID says nothing about Studio on the new one.
    expect(plugin.state().studio).toBeUndefined();
    expect(plugin.state().entries[0]?.topics).toEqual({
      set: "microflow/second_id/app/variable/1-2/set",
      value: "microflow/second_id/figma/variable/1-2",
    });

    plugin.studio.publish("microflow/first_id/app/variable/1-2/set", "0.9");
    expect(plugin.design.writes).toEqual([]);
    plugin.studio.publish("microflow/second_id/app/variable/1-2/set", "0.9");
    expect(plugin.design.writes).toEqual([{ id: "VariableID:1:2", value: 0.9 }]);
  });

  test("two quick saves leave one connection, with the last settings", async () => {
    const plugin = openPlugin({ stored: stored("first_id") });
    await tick();

    plugin.session.saveSettings(settings("older_id"));
    plugin.session.saveSettings(settings("newer_id"));
    await tick();

    expect(plugin.broker.connections().map((connection) => connection.will.topic)).toEqual([
      "microflow/newer_id/figma/status",
    ]);
    expect(plugin.state().settings?.bridgeId).toBe("newer_id");
    expect(plugin.state().connection).toBe("connected");
    expect(plugin.broker.retained("microflow/first_id/figma/status")).toBe("disconnected");
    expect(plugin.broker.retained("microflow/older_id/figma/status")).toBeUndefined();
    expect(plugin.broker.retained("microflow/newer_id/figma/status")).toBe("connected");
  });
});
