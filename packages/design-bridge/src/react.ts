/**
 * UI-side hooks and stores shared by the plugin UIs. They import `react`; the
 * Figma plugin resolves that to `preact/compat`.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { create } from "zustand";
import { randomBridgeId } from "./pairing";
import type { MessageMap, MessageType, PluginMessage, UiTransport } from "./rpc";
import {
  type BridgeSettings,
  type BridgeSettingsErrors,
  DEFAULT_BROKER_URL,
  type PluginBridgeSession,
  type PluginBridgeState,
} from "./session";

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

  /**
   * Call `onMessage` for every message of `type`. Register when the UI script
   * loads, before the bridge session says hello: a listener that waits for a
   * component to mount can miss what the sandbox sends in reply.
   */
  function on<T extends MessageType>(type: T, onMessage: (payload: MessageMap[T]) => void) {
    return transport.listen((message) => {
      if (message.type === type) onMessage(message.payload as MessageMap[T]);
    });
  }

  return { send, next, on };
}

// ── Stores ───────────────────────────────────────────────────────────

export type AppState = {
  darkMode: boolean;
  setDarkMode: (dark: boolean) => void;
};

export const useAppStore = create<AppState>((set) => ({
  darkMode: false,
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

// ── The bridge session ───────────────────────────────────────────────

/** The session's state: the settings, the connection, Studio's presence and the entries. */
export function useBridgeSession(session: PluginBridgeSession): PluginBridgeState {
  return useSyncExternalStore(session.subscribe, session.getState);
}

export type BridgeSettingsFields = Required<BridgeSettings>;

/**
 * Form state for the settings page. It starts from the saved settings, with
 * their errors when the session could not use them. `submit` saves through the
 * session, which validates; `onSaved` hears whether the settings could also be
 * stored.
 */
export function useBridgeSettingsForm(
  session: PluginBridgeSession,
  onSaved: (stored: boolean) => void,
) {
  const { settings, settingsErrors } = useBridgeSession(session);
  const fromSettings = (current: BridgeSettings | null): BridgeSettingsFields => ({
    url: current?.url || DEFAULT_BROKER_URL,
    bridgeId: current?.bridgeId ?? "",
    username: current?.username ?? "",
    password: current?.password ?? "",
  });
  const [fields, setFields] = useState(() => fromSettings(settings));
  const [errors, setErrors] = useState<BridgeSettingsErrors>(settingsErrors ?? {});

  useEffect(() => {
    setFields(fromSettings(settings));
    setErrors(settingsErrors ?? {});
  }, [settings, settingsErrors]);

  const setField = useCallback((name: keyof BridgeSettingsFields, value: string) => {
    setFields((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  }, []);

  const randomizeId = useCallback(() => setField("bridgeId", randomBridgeId()), [setField]);

  const submit = useCallback(() => {
    const result = session.saveSettings(fields);
    setErrors(result.ok ? {} : result.errors);
    if (result.ok) onSaved(result.stored);
    return result.ok;
  }, [fields, session, onSaved]);

  return { fields, errors, setField, randomizeId, submit };
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
