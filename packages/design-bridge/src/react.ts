/**
 * UI-side hooks and stores shared by the plugin UIs. They import `react`; the
 * Figma plugin resolves that to `preact/compat`.
 */
import { type MqttConfig, mqttUrlSchema, useMqttStore } from "@microflow/mqtt";
import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { type BridgeMqtt, type BridgeSnapshotEntry, DesignBridge } from "./bridge";
import { randomBridgeId, validateBridgeId } from "./pairing";
import type { DesignTool } from "./protocol";
import {
  type MessageMap,
  type MessageType,
  type PluginMessage,
  type UiTransport,
  MSG,
  messages,
} from "./rpc";

// ── Channel to the sandbox ───────────────────────────────────────────

export type UiChannel = ReturnType<typeof createUiChannel>;

export function createUiChannel(transport: UiTransport) {
  function send(message: PluginMessage) {
    transport.send(message);
  }

  /** Resolve with the payload of the next message of `type`. */
  function next<T extends MessageType>(type: T): Promise<MessageMap[T]> {
    return new Promise((resolve) => {
      const stop = transport.listen((message) => {
        if (message.type !== type) return;
        stop();
        resolve(message.payload as MessageMap[T]);
      });
    });
  }

  /** Call `onMessage` for every message of `type` while the component is mounted. */
  function useMessage<T extends MessageType>(
    type: T,
    onMessage: (payload: MessageMap[T]) => void,
  ) {
    const callback = useRef(onMessage);
    callback.current = onMessage;
    useEffect(
      () =>
        transport.listen((message) => {
          if (message.type === type) callback.current(message.payload as MessageMap[T]);
        }),
      [type],
    );
  }

  return { send, next, useMessage };
}

// ── Stores ───────────────────────────────────────────────────────────

export type AppState = {
  /** The sandbox answered UI_READY. */
  pluginReady: boolean;
  mqttConfig: MqttConfig | null;
  darkMode: boolean;
  setPluginReady: (ready: boolean) => void;
  setMqttConfig: (config: MqttConfig | null) => void;
  setDarkMode: (dark: boolean) => void;
};

export const useAppStore = create<AppState>((set) => ({
  pluginReady: false,
  mqttConfig: null,
  darkMode: false,
  setPluginReady: (pluginReady) => set({ pluginReady }),
  setMqttConfig: (mqttConfig) => set({ mqttConfig }),
  setDarkMode: (darkMode) => set({ darkMode }),
}));

export type Page = "home" | "mqtt" | "variables";

type NavigationState = {
  page: Page;
  history: Page[];
  canGoBack: boolean;
  navigate: (page: Page) => void;
  goBack: () => void;
};

export const useNavigation = create<NavigationState>((set, get) => ({
  page: "home",
  history: [],
  canGoBack: false,
  navigate: (page) =>
    set((state) => ({ page, history: [...state.history, state.page], canGoBack: true })),
  goBack: () => {
    const { history } = get();
    set({
      page: history[history.length - 1] ?? "home",
      history: history.slice(0, -1),
      canGoBack: history.length > 1,
    });
  },
}));

// ── Settings ─────────────────────────────────────────────────────────

/** The storage key both plugins have used for their settings. */
export const SETTINGS_KEY = "app-state";

/** Where a plugin keeps its settings: Figma's client storage, Penpot's localStorage. */
export interface SettingsStorage {
  load(): Promise<unknown>;
  save(value: unknown): void;
}

/** Read the MQTT settings from what a plugin stored, in the `{ state: { mqttConfig } }` shape. */
export function readStoredMqttConfig(stored: unknown): MqttConfig | null {
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
    // The old default: a bare host resolves to port 8883, which is not a
    // WebSocket listener on test.mosquitto.org, so it never connected.
    url: url.trim() === LEGACY_DEFAULT_BROKER ? DEFAULT_BROKER_URL : url,
    uniqueId,
    username: typeof username === "string" ? username : undefined,
    password: typeof password === "string" ? password : undefined,
  };
}

export function storedMqttConfig(config: MqttConfig) {
  return { state: { mqttConfig: config } };
}

/**
 * Say hello to the sandbox, then load the stored settings into the app store.
 * Mount once, at the root of the UI.
 */
export function usePluginStartup(channel: UiChannel, storage: SettingsStorage) {
  const { setPluginReady, setMqttConfig } = useAppStore();

  channel.useMessage(MSG.UI_READY, () => {
    setPluginReady(true);
    void storage.load().then((stored) => {
      const config = readStoredMqttConfig(stored);
      if (config) setMqttConfig(config);
    });
  });

  useEffect(() => {
    channel.send(messages.uiReady());
  }, [channel]);
}

/** Connect to the broker whenever the settings change. */
export function useMqttAutoConnect(tool: DesignTool) {
  const { connect } = useMqttStore();
  const { mqttConfig } = useAppStore();
  useEffect(() => {
    if (mqttConfig) connect(mqttConfig, tool);
  }, [connect, mqttConfig, tool]);
}

/** The plugins' default broker: the public test.mosquitto.org WebSocket listener. */
export const DEFAULT_BROKER_URL = "wss://test.mosquitto.org:8081/mqtt";
const LEGACY_DEFAULT_BROKER = "test.mosquitto.org";

export type MqttSettingsFields = {
  url: string;
  uniqueId: string;
  username: string;
  password: string;
};

/** Form state and validation for the MQTT settings page. */
export function useMqttSettingsForm(onSave: (config: MqttConfig) => void) {
  const { mqttConfig } = useAppStore();
  const fromConfig = (config: MqttConfig | null): MqttSettingsFields => ({
    url: config?.url || DEFAULT_BROKER_URL,
    uniqueId: config?.uniqueId ?? "",
    username: config?.username ?? "",
    password: config?.password ?? "",
  });
  const [fields, setFields] = useState(() => fromConfig(mqttConfig));
  const [errors, setErrors] = useState<Partial<Record<keyof MqttSettingsFields, string>>>({});

  useEffect(() => setFields(fromConfig(mqttConfig)), [mqttConfig]);

  const setField = useCallback((name: keyof MqttSettingsFields, value: string) => {
    setFields((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  }, []);

  const randomizeId = useCallback(() => setField("uniqueId", randomBridgeId()), [setField]);

  const submit = useCallback(() => {
    const next: typeof errors = {};
    const url = mqttUrlSchema.safeParse(fields.url.trim());
    if (!url.success) next.url = url.error.issues[0]?.message ?? "Invalid URL";
    const idError = validateBridgeId(fields.uniqueId.trim());
    if (idError) next.uniqueId = idError;
    setErrors(next);
    if (Object.keys(next).length > 0) return false;
    onSave({
      url: fields.url.trim(),
      uniqueId: fields.uniqueId.trim(),
      username: fields.username || undefined,
      password: fields.password || undefined,
    });
    return true;
  }, [fields, onSave]);

  return { fields, errors, setField, randomizeId, submit };
}

// ── The bridge ───────────────────────────────────────────────────────

/** How often the UI asks the sandbox for a fresh snapshot. Neither tool has a change event. */
export const POLL_INTERVAL_MS = 250;

/**
 * Run the design bridge while MQTT is connected, and keep the latest snapshot
 * for the UI. Mount once, at the root of the UI.
 */
export function useDesignBridge(
  tool: DesignTool,
  channel: UiChannel,
  options: { onInvalid?: (name: string, payload: string) => void } = {},
) {
  const { status, uniqueId, publish, subscribe } = useMqttStore();
  const [entries, setEntries] = useState<BridgeSnapshotEntry[]>([]);
  const lastSnapshot = useRef("");
  const bridge = useRef<DesignBridge | null>(null);
  const onInvalid = useRef(options.onInvalid);
  onInvalid.current = options.onInvalid;

  useEffect(() => {
    if (status !== "connected" || !uniqueId) return;
    const mqtt: BridgeMqtt = {
      publish: (topic, payload, publishOptions) => publish(topic, payload, publishOptions),
      subscribe: (topic, onMessage) =>
        subscribe(topic, (received, payload) => onMessage(received, payload.toString())),
    };
    const instance = new DesignBridge({
      tool,
      uid: uniqueId,
      mqtt,
      write: (id, value) => channel.send(messages.setVariable(id, value)),
      onInvalid: (variable, payload) => onInvalid.current?.(variable.name, payload),
    });
    instance.start();
    bridge.current = instance;
    channel.send(messages.getVariables());
    return () => {
      instance.stop();
      bridge.current = null;
    };
  }, [status, uniqueId, publish, subscribe, tool, channel]);

  channel.useMessage(MSG.GET_VARIABLES, (snapshot) => {
    if (!snapshot) return;
    bridge.current?.update(snapshot);
    const json = JSON.stringify(snapshot);
    if (json === lastSnapshot.current) return;
    lastSnapshot.current = json;
    setEntries(snapshot);
  });

  useEffect(() => {
    channel.send(messages.getVariables());
    const timer = setInterval(() => channel.send(messages.getVariables()), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [channel]);

  return entries;
}

// ── Small helpers ────────────────────────────────────────────────────

/** Copy text to the clipboard; `copied` holds the last copied text for 1.5 s. */
export function useCopyToClipboard(onResult?: (ok: boolean) => void) {
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(
    (text: string) => {
      const done = (ok: boolean) => {
        if (ok) setCopied(text);
        onResult?.(ok);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(
          () => done(true),
          () => done(copyWithTextarea(text)),
        );
        return;
      }
      done(copyWithTextarea(text));
    },
    [onResult],
  );

  return [copied, copy] as const;
}

/** Plugin iframes often lack clipboard permission; this fallback still works there. */
function copyWithTextarea(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  return ok;
}
