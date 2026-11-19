/**
 * The plugin bridge session: everything a design-tool plugin's UI iframe does
 * between its sandbox and the broker. It owns the settings, the broker
 * connection, the plugin's presence (`{tool}/status` and its last will), the
 * `DesignBridge` engine and the snapshot polling. A plugin's views read its
 * state and call `saveSettings`; they wire nothing.
 *
 * Framework-free. `react.ts` has the hook that reads the state.
 */
import { type BridgeSnapshotEntry, DesignBridge } from "./bridge";
import type { BrokerConnection, BrokerConnector, ConnectionStatus } from "./broker";
import { type BrokerUrl, DEFAULT_BROKER_URL, parseBrokerUrl } from "./broker-url";
import { mqttBroker } from "./mqtt-broker";
import { validateBridgeId } from "./pairing";
import {
  type BridgeVariable,
  type DesignTool,
  PRESENCE,
  type Presence,
  STUDIO,
  parseTopic,
  toWireId,
  topics,
} from "./protocol";
import { MSG, type UiTransport, messages } from "./rpc";

export type { ConnectionStatus } from "./broker";
export { DEFAULT_BROKER_URL } from "./broker-url";

/** What the user enters on the settings page. */
export type BridgeSettings = {
  /** `[ws://|wss://]host[:port][/path]`, see `broker-url.ts`. */
  url: string;
  bridgeId: string;
  username?: string;
  password?: string;
};

export type BridgeSettingsErrors = { url?: string; bridgeId?: string };

/** The settings an error can be about, as the settings page labels and orders them. */
const SETTING_LABELS: [keyof BridgeSettingsErrors, string][] = [
  ["bridgeId", "Bridge ID"],
  ["url", "Broker URL"],
];

/**
 * What is wrong with the settings, one line per setting, for a screen that
 * shows the connection but not the settings form
 * (`Bridge ID: Use at most 64 characters`). Empty when nothing is.
 */
export function settingsProblems(errors: BridgeSettingsErrors | null): string[] {
  return SETTING_LABELS.flatMap(([setting, label]) => {
    const error = errors?.[setting];
    return error ? [`${label}: ${error}`] : [];
  });
}

export type SaveSettingsResult =
  /** The settings are in use. `stored` is false when the storage refused them. */
  | { ok: true; stored: boolean }
  /** Nothing changed. */
  | { ok: false; errors: BridgeSettingsErrors };

/** A bridge variable, its value, and the topics a user can copy for it. */
export type PluginBridgeEntry = BridgeSnapshotEntry & {
  /** `null` while there is no Bridge ID to build them with. */
  topics: {
    /** Publish here to change the variable. */
    set: string;
    /** Subscribe here for the variable's values. */
    value: string;
  } | null;
};

export type PluginBridgeState = {
  /** The saved settings; `null` when none are saved. They are in use unless `settingsErrors` is set. */
  settings: BridgeSettings | null;
  /**
   * Why the stored settings are not in use: they do not pass today's rules, so
   * the session did not connect with them. `null` in every other case.
   */
  settingsErrors: BridgeSettingsErrors | null;
  /** The broker connection; `undefined` while there are no settings. */
  connection: ConnectionStatus | undefined;
  /** Studio's presence on this Bridge ID; `undefined` until Studio has announced itself. */
  studio: Presence | undefined;
  entries: PluginBridgeEntry[];
};

export interface PluginBridgeSession {
  getState(): PluginBridgeState;
  /** Call `listener` after every state change. Returns the function that stops it. */
  subscribe(listener: () => void): () => void;
  /**
   * Validate the settings; when they are valid, connect with them and store
   * them. The connection that was open is replaced, never kept beside the new one.
   */
  saveSettings(settings: BridgeSettings): SaveSettingsResult;
  /**
   * Stop polling and drop the connection, so the broker publishes the last will.
   * The session cannot be used after this. A plugin never calls it: its session
   * lives exactly as long as its UI window, and closing the window drops the
   * connection the same way. Tests call it to close the window.
   */
  dispose(): void;
}

/** The storage key both plugins use for their settings. */
export const SETTINGS_KEY = "app-state";

/** Where a plugin keeps its settings: Figma's client storage, Penpot's localStorage. */
export interface SettingsStorage {
  load(): Promise<unknown>;
  /** May throw when the storage is not available. */
  save(value: unknown): void;
}

export type PluginBridgeSessionOptions = {
  tool: DesignTool;
  /** The channel to the plugin's sandbox, which reads and writes the design file. */
  sandbox: UiTransport;
  storage: SettingsStorage;
  /** An incoming value did not fit the variable's type and was dropped. */
  onInvalid?: (variable: BridgeVariable, payload: string) => void;
  /** How to reach a broker. The default is mqtt.js; tests pass the in-memory broker. */
  broker?: BrokerConnector;
};

/** How often the session asks the sandbox for a fresh snapshot. Neither tool has a change event. */
export const POLL_INTERVAL_MS = 250;

/**
 * Start a session: say hello to the sandbox, load the stored settings when it
 * answers, connect with them, and poll the sandbox for snapshots from then on.
 */
export function createPluginBridgeSession(options: PluginBridgeSessionOptions): PluginBridgeSession {
  const { tool, sandbox, storage } = options;
  const connect = options.broker ?? mqttBroker;

  /** One broker connection and the engine that publishes over it. */
  type Link = {
    uid: string;
    statusTopic: string;
    connection: BrokerConnection;
    bridge: DesignBridge;
    up: boolean;
    /** The broker sent this connection's latest `connected` announcement back. */
    announced: boolean;
  };

  let state: PluginBridgeState = {
    settings: null,
    settingsErrors: null,
    connection: undefined,
    studio: undefined,
    entries: [],
  };
  const listeners = new Set<() => void>();
  let link: Link | null = null;
  /** The last snapshot the sandbox sent; `null` until the first one. */
  let snapshot: BridgeSnapshotEntry[] | null = null;
  let snapshotJson = "";
  let loading = false;
  let disposed = false;

  function setState(patch: Partial<PluginBridgeState>) {
    const keys = Object.keys(patch) as Array<keyof PluginBridgeState>;
    if (keys.every((key) => state[key] === patch[key])) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  /** The snapshot with the topics of the Bridge ID in use, if there is one. */
  function entries(): PluginBridgeEntry[] {
    const uid = link?.uid;
    return (snapshot ?? []).map((entry) => {
      const wireId = toWireId(entry.variable.id);
      return {
        ...entry,
        topics: uid ? { set: topics.set(uid, wireId), value: topics.value(uid, tool, wireId) } : null,
      };
    });
  }

  function announce(current: Link) {
    current.announced = false;
    current.connection.publish(current.statusTopic, PRESENCE.connected, { retain: true, qos: 2 });
  }

  function onConnectionStatus(current: Link, status: ConnectionStatus) {
    const wasUp = current.up;
    current.up = status === "connected";
    if (current.up) {
      announce(current);
      // The engine runs while the connection is up, and starts from nothing:
      // the broker kept no subscription and no value from before a drop.
      current.bridge.start();
      current.bridge.reset();
      if (snapshot) current.bridge.update(snapshot);
      sandbox.send(messages.getVariables());
    } else if (wasUp) {
      current.bridge.stop();
    }
    setState({ connection: status });
  }

  function onStatusMessage(current: Link, topic: string, payload: string) {
    const parsed = parseTopic(topic);
    if (parsed?.kind !== "status") return;
    if (parsed.client === STUDIO) {
      if (payload === PRESENCE.connected || payload === PRESENCE.disconnected) {
        setState({ studio: payload });
      }
      return;
    }
    if (topic !== current.statusTopic || !current.up) return;
    if (payload === PRESENCE.connected) {
      current.announced = true;
      return;
    }
    // Until the announcement has come back, what arrives here is older than
    // it: the retained last will of an earlier window, which the announcement
    // replaces. After that, something else said this plugin is gone: the late
    // last will of the connection this one replaced, or of a second editor
    // with the same Bridge ID.
    if (current.announced) announce(current);
  }

  function close() {
    if (!link) return;
    const closing = link;
    link = null;
    closing.connection.end();
    closing.bridge.stop();
  }

  /** Replace the connection. There is no pause between the old one and the new one. */
  function open(settings: BridgeSettings, url: BrokerUrl) {
    close();
    const uid = settings.bridgeId;
    const statusTopic = topics.status(uid, tool);
    const connection = connect({
      url,
      clientId: `microflow_${tool}_${uid}_${Date.now().toString(36)}`,
      username: settings.username,
      password: settings.password,
      will: { topic: statusTopic, payload: PRESENCE.disconnected, retain: true, qos: 2 },
      onStatus: (status) => {
        if (link === current) onConnectionStatus(current, status);
      },
    });
    const bridge = new DesignBridge({
      tool,
      uid,
      mqtt: connection,
      write: (id, value) => sandbox.send(messages.setVariable(id, value)),
      onInvalid: (variable, payload) => options.onInvalid?.(variable, payload),
    });
    const current: Link = { uid, statusTopic, connection, bridge, up: false, announced: false };
    link = current;
    connection.subscribe(topics.anyStatus(uid), (topic, payload) => {
      if (link === current) onStatusMessage(current, topic, payload);
    });
  }

  function apply(settings: BridgeSettings, url: BrokerUrl) {
    open(settings, url);
    setState({
      settings,
      settingsErrors: null,
      connection: "connecting",
      // Presence belongs to one Bridge ID on one broker.
      studio: undefined,
      entries: entries(),
    });
  }

  function onSnapshot(next: BridgeSnapshotEntry[]) {
    snapshot = next;
    if (link?.up) link.bridge.update(next);
    const json = JSON.stringify(next);
    if (json === snapshotJson) return;
    snapshotJson = json;
    setState({ entries: entries() });
  }

  async function loadSettings() {
    if (loading) return;
    loading = true;
    let stored: unknown;
    try {
      stored = await storage.load();
    } catch (error) {
      console.error("[bridge] could not load the settings", error);
      return;
    }
    // Settings the user saved while the storage was read are newer than what it held.
    if (disposed || state.settings) return;
    const settings = readStoredSettings(stored);
    if (!settings) return;
    const checked = checkSettings(settings);
    if (checked.ok) {
      apply(checked.settings, checked.url);
    } else {
      // Stored under older rules: show them, with what is wrong, and do not connect.
      setState({ settings, settingsErrors: checked.errors, connection: "disconnected" });
    }
  }

  const stopListening = sandbox.listen((message) => {
    if (message.type === MSG.UI_READY) void loadSettings();
    if (message.type === MSG.GET_VARIABLES && message.payload) onSnapshot(message.payload);
  });
  sandbox.send(messages.uiReady());
  sandbox.send(messages.getVariables());
  const poll = setInterval(() => sandbox.send(messages.getVariables()), POLL_INTERVAL_MS);

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    saveSettings(input) {
      const checked = checkSettings(input);
      if (!checked.ok) return checked;
      apply(checked.settings, checked.url);
      try {
        storage.save(storedSettings(checked.settings));
        return { ok: true, stored: true };
      } catch {
        return { ok: true, stored: false };
      }
    },

    dispose() {
      disposed = true;
      clearInterval(poll);
      stopListening();
      close();
      listeners.clear();
    },
  };
}

type CheckedSettings =
  | { ok: true; settings: BridgeSettings; url: BrokerUrl }
  | { ok: false; errors: BridgeSettingsErrors };

/** Trim what the user typed and check it: a parseable broker URL and a valid Bridge ID. */
function checkSettings(input: BridgeSettings): CheckedSettings {
  const settings: BridgeSettings = {
    url: input.url.trim(),
    bridgeId: input.bridgeId.trim(),
    username: input.username || undefined,
    password: input.password || undefined,
  };
  const url = parseBrokerUrl(settings.url);
  const bridgeIdError = validateBridgeId(settings.bridgeId);
  if (url.ok && bridgeIdError === null) return { ok: true, settings, url: url.url };
  return {
    ok: false,
    errors: {
      ...(!url.ok && { url: url.error }),
      ...(bridgeIdError !== null && { bridgeId: bridgeIdError }),
    },
  };
}

/** The first default broker: a bare host, so port 8883, where test.mosquitto.org has no WebSocket listener. */
const LEGACY_DEFAULT_BROKER = "test.mosquitto.org";

/**
 * Read the settings from what a plugin stored. The stored shape is
 * `{ state: { mqttConfig: { url, uniqueId, username?, password? } } }`, as an
 * object (Figma) or as JSON text (Penpot); installed plugins hold it, so it
 * keeps its field names.
 */
function readStoredSettings(stored: unknown): BridgeSettings | null {
  let value = stored;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const config = (value as { state?: { mqttConfig?: unknown } } | null)?.state?.mqttConfig;
  if (typeof config !== "object" || config === null) return null;
  const { url, uniqueId, username, password } = config as Record<string, unknown>;
  if (typeof url !== "string" || typeof uniqueId !== "string") return null;
  return {
    url: url.trim() === LEGACY_DEFAULT_BROKER ? DEFAULT_BROKER_URL : url,
    bridgeId: uniqueId,
    username: typeof username === "string" ? username : undefined,
    password: typeof password === "string" ? password : undefined,
  };
}

function storedSettings({ bridgeId, ...rest }: BridgeSettings) {
  return { state: { mqttConfig: { ...rest, uniqueId: bridgeId } } };
}
