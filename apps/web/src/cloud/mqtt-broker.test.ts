// The broker settings and their one settle point: the settings form writes a
// field at every keystroke, and everything that connects reads what has
// settled. The first block drives a store of its own on virtual time; the rest
// is the app's store as its consumers see it (`CloudDeps.resolveBroker`,
// `CloudDeps.watchBrokers`, a performer joined to both).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CloudPerformer } from "./cloud-performer";
import { FakeTimers } from "@/lib/fake-timers";
import {
  BROKER_SETTINGS_SETTLE_MS,
  brokerSettingsForm,
  createMqttBrokerStore,
  holdBrokerSettingsForm,
  onBrokerSettingsChange,
  resolveStoredBroker,
  settleBrokerSettings,
  useMqttBrokerStore,
  type MqttBrokerConfig,
} from "./mqtt-broker";
import type { BrokerConn, MqttClientFactory } from "./mqtt-client";

const LAB: MqttBrokerConfig = {
  id: "lab",
  name: "Lab",
  url: "wss://lab.example/mqtt",
  username: "studio",
  password: "wrnog",
  isDefault: true,
};
const HOME: MqttBrokerConfig = { id: "home", name: "Home", url: "wss://home.example", isDefault: false };

/** A store of its own on virtual time, holding `brokers`. */
function settings(brokers: MqttBrokerConfig[] = [{ ...LAB }, { ...HOME }]) {
  const timers = new FakeTimers();
  const store = createMqttBrokerStore({ timers });
  store.setState({ brokers });
  /** The settled broker lists the store's observers were shown, in order. */
  const settled: MqttBrokerConfig[][] = [];
  store.subscribe((state, previous) => {
    if (state.brokers !== previous.brokers) settled.push(state.brokers);
  });
  const state = () => store.getState();
  /** What everything that connects reads. */
  const stored = (id: string) => state().brokers.find((broker) => broker.id === id);
  /** What the settings form shows. */
  const shown = (id: string) => brokerSettingsForm(state()).brokers.find((broker) => broker.id === id);
  /** Type `text` into a field of the form, a character every 100 ms. */
  const type = (id: string, field: "name" | "url" | "username" | "password", text: string): void => {
    for (let length = 1; length <= text.length; length++) {
      state().updateBroker(id, { [field]: text.slice(0, length) });
      timers.advance(100);
    }
  };
  return { store, timers, settled, state, stored, shown, type };
}

describe("broker settings typed into the form", () => {
  test("are shown at once and settle half a second after the last keystroke, in one change", () => {
    const { timers, settled, state, stored, shown } = settings();
    const url = "wss://lab.example:8884/mqtt";

    for (let length = 1; length <= url.length; length++) {
      state().updateBroker("lab", { url: url.slice(0, length) });
      expect(shown("lab")?.url).toBe(url.slice(0, length));
      expect(stored("lab")?.url).toBe(LAB.url);
      timers.advance(100);
    }

    // 100 ms have passed since the last character.
    timers.advance(BROKER_SETTINGS_SETTLE_MS - 101);
    expect(settled).toEqual([]);
    timers.advance(1);

    expect(settled).toHaveLength(1);
    expect(stored("lab")).toEqual({ ...LAB, url });
    expect(shown("lab")).toEqual({ ...LAB, url });
    expect(state().unsettled).toEqual({});
  });

  test("settle to what was typed so far when the typing pauses for longer", () => {
    const { timers, settled, stored, type } = settings();

    // The user stops to look the rest up.
    type("lab", "url", "wss://host");
    timers.advance(BROKER_SETTINGS_SETTLE_MS);
    expect(stored("lab")?.url).toBe("wss://host");

    type("lab", "url", "wss://host.test:9001");
    timers.advance(BROKER_SETTINGS_SETTLE_MS);

    expect(stored("lab")?.url).toBe("wss://host.test:9001");
    expect(settled).toHaveLength(2);
  });

  test("settle together when a URL, a username and a password are typed without a pause", () => {
    const { timers, settled, stored, type } = settings();

    type("lab", "url", "wss://other.example");
    type("lab", "username", "ada");
    type("lab", "password", "right");
    expect(settled).toEqual([]);
    timers.advance(BROKER_SETTINGS_SETTLE_MS);

    expect(settled).toHaveLength(1);
    expect(stored("lab")).toEqual({ ...LAB, url: "wss://other.example", username: "ada", password: "right" });
  });

  test("settle per broker: an edit to another broker neither postpones nor hurries one", () => {
    const { timers, state, stored } = settings();

    state().updateBroker("lab", { url: "wss://other.example" });
    timers.advance(BROKER_SETTINGS_SETTLE_MS - 100);
    state().updateBroker("home", { url: "wss://home.example:8884" });
    expect(stored("lab")?.url).toBe(LAB.url);

    timers.advance(100);
    expect(stored("lab")?.url).toBe("wss://other.example");
    expect(stored("home")?.url).toBe(HOME.url);

    timers.advance(BROKER_SETTINGS_SETTLE_MS - 100);
    expect(stored("home")?.url).toBe("wss://home.example:8884");
  });

  test("settle to no change when they are typed back to what they were", () => {
    const { timers, settled, state } = settings();

    state().updateBroker("lab", { url: "wss://other.example" });
    timers.advance(BROKER_SETTINGS_SETTLE_MS / 2);
    state().updateBroker("lab", { url: LAB.url });
    timers.advance(BROKER_SETTINGS_SETTLE_MS);

    expect(settled).toEqual([]);
    expect(state().unsettled).toEqual({});
  });

  test("are dropped for a broker that is not there", () => {
    const { timers, settled, state } = settings();

    state().updateBroker("gone", { url: "wss://other.example" });
    timers.advance(BROKER_SETTINGS_SETTLE_MS);

    expect(state().unsettled).toEqual({});
    expect(settled).toEqual([]);
    expect(timers.waiting).toBe(0);
  });
});

describe("changes that are not typing", () => {
  test("a broker added, a broker removed and another default are settled at once, also while a URL is typed", () => {
    const { state, stored, shown } = settings();
    state().updateBroker("lab", { url: "wss://other.exam" });

    const added = state().addBroker({ name: "Shed", url: "wss://shed.example", isDefault: false });
    expect(stored(added)?.url).toBe("wss://shed.example");
    state().setDefaultBroker("home");
    expect(stored("home")?.isDefault).toBe(true);
    state().deleteBroker(added);
    expect(stored(added)).toBeUndefined();

    // The URL being typed is still only the form's.
    expect(stored("lab")?.url).toBe(LAB.url);
    expect(shown("lab")).toEqual({ ...LAB, url: "wss://other.exam", isDefault: false });
  });

  test("a removed broker does not come back when what was typed for it would have settled", () => {
    const { timers, settled, state, stored, shown } = settings();
    state().updateBroker("home", { url: "wss://home.example:8884" });

    state().deleteBroker("home");
    expect(settled).toHaveLength(1);
    timers.advance(BROKER_SETTINGS_SETTLE_MS);

    expect(stored("home")).toBeUndefined();
    expect(shown("home")).toBeUndefined();
    expect(state().unsettled).toEqual({});
    expect(settled).toHaveLength(1);
    expect(timers.waiting).toBe(0);
  });

  test("settle() delivers everything that is typed at once, in one change, and ends the waits", () => {
    const { timers, settled, state, stored } = settings();
    state().updateBroker("lab", { password: "right" });
    state().updateBroker("home", { url: "wss://home.example:8884" });

    state().settle();

    expect(settled).toHaveLength(1);
    expect(stored("lab")?.password).toBe("right");
    expect(stored("home")?.url).toBe("wss://home.example:8884");
    expect(timers.waiting).toBe(0);

    state().settle();
    timers.advance(BROKER_SETTINGS_SETTLE_MS);
    expect(settled).toHaveLength(1);
  });
});

describe("the status dot the form shows", () => {
  test("is `connecting` for a broker whose connection settings are typed and not settled", () => {
    const { state } = settings();
    state().setStatuses({ lab: "connected", home: "error" });
    const dots = () => brokerSettingsForm(state()).statuses;

    // A name is not something a broker is connected with.
    state().updateBroker("lab", { name: "Laboratory" });
    expect(dots()).toEqual({ lab: "connected", home: "error" });

    state().updateBroker("lab", { url: "wss://other.example" });
    expect(dots()).toEqual({ lab: "connecting", home: "error" });
    // Everything but the form still reads the status of the settled connection.
    expect(state().statuses.lab).toBe("connected");

    // Typed back: the connection the status is of is the one on screen again.
    state().updateBroker("lab", { url: LAB.url });
    expect(dots()).toEqual({ lab: "connected", home: "error" });

    state().updateBroker("lab", { password: "right" });
    expect(dots().lab).toBe("connecting");
  });

  test("stays `connecting` when the settings have settled, until the host says how the new connection fares", () => {
    const { timers, state } = settings();
    state().setStatuses({ lab: "connected", home: "error" });

    state().updateBroker("lab", { password: "right" });
    state().updateBroker("home", { name: "Home office" });
    timers.advance(BROKER_SETTINGS_SETTLE_MS);

    // The status that was held is of a connection that is no longer the
    // broker's; a new name leaves the connection, and its status, alone.
    expect(state().statuses).toEqual({ lab: "connecting", home: "error" });
    expect(brokerSettingsForm(state()).statuses).toEqual({ lab: "connecting", home: "error" });

    state().setStatuses({ lab: "connected", home: "error" });
    expect(brokerSettingsForm(state()).statuses.lab).toBe("connected");
  });
});

describe("the stored broker settings", () => {
  /** `localStorage`, as far as the store uses it. */
  function memoryStorage() {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (name: string) => items.get(name) ?? null,
      setItem: (name: string, value: string) => void items.set(name, value),
      removeItem: (name: string) => void items.delete(name),
    };
  }

  test("hold what is typed from the keystroke on, and are settled when they are loaded", () => {
    const storage = memoryStorage();
    const timers = new FakeTimers();
    const store = createMqttBrokerStore({ timers, storage });
    const id = store.getState().addBroker({ name: "Lab", url: "", isDefault: true });

    store.getState().updateBroker(id, { url: "wss://lab.example/mqtt" });
    expect(store.getState().brokers[0]?.url).toBe("");

    // The app is closed before the settle time has passed, and opened again.
    const reopened = createMqttBrokerStore({ timers: new FakeTimers(), storage });

    expect(reopened.getState().brokers).toEqual([
      { id, name: "Lab", url: "wss://lab.example/mqtt", isDefault: true },
    ]);
    expect(reopened.getState().unsettled).toEqual({});
  });
});

// ── the app's store, as its consumers see it ────────────────────────────────

const store = () => useMqttBrokerStore.getState();

const watches: Array<() => void> = [];
/** The broker ids the store reports from here on, one entry per report. */
function reports(): string[][] {
  const seen: string[][] = [];
  watches.push(onBrokerSettingsChange((brokerIds) => seen.push([...brokerIds])));
  return seen;
}

beforeEach(() => {
  useMqttBrokerStore.setState({ brokers: [{ ...LAB }], unsettled: {}, statuses: {} });
});

afterEach(() => {
  // A watch left in place would see the store edits of later tests.
  for (const unwatch of watches.splice(0)) unwatch();
  // Ends the waits of whatever a test left typed.
  settleBrokerSettings();
  useMqttBrokerStore.setState({ brokers: [], unsettled: {}, statuses: {} });
});

describe("resolveStoredBroker", () => {
  test("gives the connection half of a stored broker, as it has settled", () => {
    expect(resolveStoredBroker("lab")).toEqual({
      id: "lab",
      url: "wss://lab.example/mqtt",
      username: "studio",
      password: "wrnog",
    });

    store().updateBroker("lab", { password: "right" });
    expect(resolveStoredBroker("lab")?.password).toBe("wrnog");

    settleBrokerSettings();
    expect(resolveStoredBroker("lab")?.password).toBe("right");
  });

  test("gives nothing for a broker that is not stored", () => {
    expect(resolveStoredBroker("gone")).toBeUndefined();
  });
});

describe("onBrokerSettingsChange", () => {
  test("reports the broker whose URL, username or password has settled, not each keystroke", () => {
    const home = store().addBroker({ name: "Home", url: "wss://home.example", isDefault: false });
    const seen = reports();

    for (const typed of ["r", "ri", "rig", "righ", "right"]) store().updateBroker("lab", { password: typed });
    store().updateBroker(home, { username: "me" });
    expect(seen).toEqual([]);

    settleBrokerSettings();
    expect(seen).toHaveLength(1);
    expect([...(seen[0] ?? [])].sort()).toEqual([home, "lab"].sort());
  });

  test("reports a broker added and a broker deleted, at once", () => {
    const seen = reports();

    const added = store().addBroker({ name: "Home", url: "", isDefault: false });
    store().deleteBroker(added);

    expect(seen).toEqual([[added], [added]]);
  });

  test("does not report a new name, another default broker or a status dot that changes", () => {
    const home = store().addBroker({ name: "Home", url: "wss://home.example", isDefault: false });
    const seen = reports();

    store().updateBroker("lab", { name: "Laboratory" });
    settleBrokerSettings();
    store().setDefaultBroker(home);
    store().setStatus("lab", "connecting");
    store().setStatuses({ lab: "connected" });
    // The default flag moves to the broker that is left: not a connection setting.
    store().deleteBroker(home);

    expect(seen).toEqual([[home]]);
  });

  test("reports nothing after its cleanup", () => {
    const seen = reports();
    for (const unwatch of watches.splice(0)) unwatch();

    store().updateBroker("lab", { password: "right" });
    settleBrokerSettings();

    expect(seen).toEqual([]);
  });
});

describe("the settings form, held open", () => {
  /** The page the form is on: `hide()` is the window being hidden or left. */
  function page() {
    const listeners = new Set<() => void>();
    return {
      listeners,
      hide: () => {
        for (const listener of listeners) listener();
      },
      watch: (onHidden: () => void) => {
        listeners.add(onHidden);
        return () => void listeners.delete(onHidden);
      },
    };
  }

  test("closing the form settles what is still typed", () => {
    const close = holdBrokerSettingsForm(page().watch);
    store().updateBroker("lab", { url: "wss://other.example" });
    expect(resolveStoredBroker("lab")?.url).toBe(LAB.url);

    close();

    expect(resolveStoredBroker("lab")?.url).toBe("wss://other.example");
    expect(store().unsettled).toEqual({});
  });

  test("hiding the page settles what is still typed, and no longer once the form is closed", () => {
    const { watch, hide, listeners } = page();
    const close = holdBrokerSettingsForm(watch);
    store().updateBroker("lab", { url: "wss://other.example" });

    hide();
    expect(resolveStoredBroker("lab")?.url).toBe("wss://other.example");

    close();
    expect(listeners.size).toBe(0);
  });
});

describe("a performer on the broker store", () => {
  /** A performer wired as the app's is, on brokers that accept every
   *  connection at once: the connections it opened and closed, by URL, and
   *  what it published on each. */
  function performing() {
    const opened: BrokerConn[] = [];
    const closed: string[] = [];
    const published: string[] = [];
    const factory: MqttClientFactory = {
      create(conn) {
        opened.push(conn);
        return {
          connected: true,
          on: (event: string, handler: (...args: never[]) => void) => {
            if (event === "connect") (handler as () => void)();
          },
          subscribe: () => {},
          unsubscribe: () => {},
          publish: (topic) => void published.push(`${conn.url} ${topic}`),
          end: () => void closed.push(conn.url),
        };
      },
    };
    const performer = new CloudPerformer(
      {
        resolveLlmProvider: () => undefined,
        resolveBroker: resolveStoredBroker,
        watchBrokers: onBrokerSettingsChange,
        timers: new FakeTimers(),
      },
      () => {},
      () => {},
      () => [],
      factory,
    );
    watches.push(() => performer.dispose());
    return { performer, opened, closed, published };
  }

  const SENSOR = { brokerId: "lab", topic: "sensors/temperature", nodeId: "mqtt", kind: "plain" } as const;
  const lightsOn = {
    kind: "mqttPublish",
    brokerId: "lab",
    topic: "lights/kitchen",
    payload: [...new TextEncoder().encode("on")],
    retain: false,
  } as const;

  test("reconnects with a password corrected on the config page, once, without a flow update", () => {
    const { performer, opened } = performing();
    performer.reconcile([SENSOR]);
    expect(opened.map((conn) => conn.password)).toEqual(["wrnog"]);

    // The status dot of the page's own probe and a new name change nothing.
    store().setStatus("lab", "error");
    store().updateBroker("lab", { name: "Laboratory" });
    settleBrokerSettings();
    expect(opened).toHaveLength(1);

    // What the password field writes, a keystroke at a time.
    for (const typed of ["r", "ri", "rig", "righ", "right"]) {
      store().updateBroker("lab", { password: typed });
    }
    expect(opened).toHaveLength(1);

    settleBrokerSettings();

    expect(opened.map((conn) => conn.password)).toEqual(["wrnog", "right"]);
  });

  test("a flow that runs while a URL is typed stays on the connection it has", () => {
    const { performer, opened, published } = performing();
    performer.reconcile([SENSOR]);
    const url = "wss://other.example";

    // Every prefix from `wss://o` on is a URL a connection can be opened to.
    for (let length = 1; length <= url.length; length++) {
      store().updateBroker("lab", { url: url.slice(0, length) });
      performer.perform(lightsOn);
      performer.reconcile([SENSOR]);
    }

    expect(opened.map((conn) => conn.url)).toEqual([LAB.url]);
    expect(published).toEqual(Array.from(url, () => `${LAB.url} lights/kitchen`));

    settleBrokerSettings();
    performer.perform(lightsOn);

    expect(opened.map((conn) => conn.url)).toEqual([LAB.url, url]);
    expect(published.at(-1)).toBe(`${url} lights/kitchen`);
  });

  test("a broker removed while its URL is typed is closed at once and not connected to again", () => {
    const { performer, opened, closed } = performing();
    performer.reconcile([SENSOR]);
    store().updateBroker("lab", { url: "wss://other.example" });

    store().deleteBroker("lab");
    expect(closed).toEqual([LAB.url]);

    settleBrokerSettings();
    performer.reconcile([SENSOR]);

    expect(opened.map((conn) => conn.url)).toEqual([LAB.url]);
    expect(resolveStoredBroker("lab")).toBeUndefined();
  });
});
