/**
 * Typed messages between a plugin's sandbox (the code with access to the design
 * file) and its UI iframe (the code with network access). Both plugins use the
 * same message set; each host supplies how a message crosses the boundary.
 */
import type { BridgeSnapshotEntry } from "./bridge";
import type { BridgeValue } from "./protocol";

export const MSG = {
  /** UI → sandbox on mount; the sandbox answers with the same type. */
  UI_READY: "UI_READY",
  /** UI → sandbox: read a stored value; the sandbox answers with the same type. */
  GET_LOCAL_STATE: "GET_LOCAL_STATE",
  /** UI → sandbox: store a value. */
  SET_LOCAL_STATE: "SET_LOCAL_STATE",
  SHOW_TOAST: "SHOW_TOAST",
  OPEN_LINK: "OPEN_LINK",
  /** UI → sandbox: resize the plugin panel. */
  RESIZE: "RESIZE",
  /** Sandbox → UI: the editor's light/dark theme. */
  THEME: "THEME",
  /** UI → sandbox: read the variables; the sandbox answers with a snapshot. The sandbox may also push one. */
  GET_VARIABLES: "GET_VARIABLES",
  /** UI → sandbox: write one variable. */
  SET_VARIABLE: "SET_VARIABLE",
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

export type Theme = "light" | "dark";

export interface MessageMap {
  [MSG.UI_READY]: undefined;
  [MSG.GET_LOCAL_STATE]: { key: string; value?: unknown };
  [MSG.SET_LOCAL_STATE]: { key: string; value: unknown };
  [MSG.SHOW_TOAST]: { message: string; error?: boolean };
  [MSG.OPEN_LINK]: string;
  [MSG.RESIZE]: { width: number; height: number };
  [MSG.THEME]: Theme;
  [MSG.GET_VARIABLES]: BridgeSnapshotEntry[] | undefined;
  [MSG.SET_VARIABLE]: { id: string; value: BridgeValue };
}

export type PluginMessage<T extends MessageType = MessageType> = {
  [K in T]: { type: K; payload: MessageMap[K] };
}[T];

function message<T extends MessageType>(type: T, payload: MessageMap[T]) {
  return { type, payload } as PluginMessage<T>;
}

export const messages = {
  uiReady: () => message(MSG.UI_READY, undefined),
  getLocalState: (key: string, value?: unknown) => message(MSG.GET_LOCAL_STATE, { key, value }),
  setLocalState: (key: string, value: unknown) => message(MSG.SET_LOCAL_STATE, { key, value }),
  showToast: (text: string, options?: { error?: boolean }) =>
    message(MSG.SHOW_TOAST, { message: text, error: options?.error }),
  openLink: (url: string) => message(MSG.OPEN_LINK, url),
  resize: (width: number, height: number) => message(MSG.RESIZE, { width, height }),
  theme: (theme: Theme) => message(MSG.THEME, theme),
  getVariables: (entries?: BridgeSnapshotEntry[]) => message(MSG.GET_VARIABLES, entries),
  setVariable: (id: string, value: BridgeValue) => message(MSG.SET_VARIABLE, { id, value }),
};

export type MessageHandlers = {
  [K in MessageType]?: (payload: MessageMap[K]) => void | Promise<void>;
};

/**
 * A dispatcher for incoming messages. A failing handler is reported to
 * `onError` and does not stop the others.
 */
export function createMessageRouter(
  handlers: MessageHandlers,
  onError: (type: MessageType, error: unknown) => void = (type, error) =>
    console.error(`[plugin] ${type} failed`, error),
) {
  return (incoming: unknown) => {
    if (!isPluginMessage(incoming)) return;
    const handler = handlers[incoming.type] as ((payload: unknown) => unknown) | undefined;
    if (!handler) return;
    try {
      const result = handler(incoming.payload);
      if (result instanceof Promise) result.catch((error) => onError(incoming.type, error));
    } catch (error) {
      onError(incoming.type, error);
    }
  };
}

const MESSAGE_TYPES = new Set<string>(Object.values(MSG));

export function isPluginMessage(value: unknown): value is PluginMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    MESSAGE_TYPES.has((value as { type?: unknown }).type as string)
  );
}

/** How a plugin UI reaches its sandbox. */
export interface UiTransport {
  send(message: PluginMessage): void;
  listen(onMessage: (message: PluginMessage) => void): () => void;
}

/**
 * The transport for a UI iframe that talks to its sandbox through `window.parent`.
 * Figma wraps every message in `{ pluginMessage }`; Penpot does not.
 */
export function createWindowTransport(options: { wrap: "pluginMessage" | "none" }): UiTransport {
  const unwrap = (data: unknown) =>
    options.wrap === "pluginMessage"
      ? (data as { pluginMessage?: unknown } | null)?.pluginMessage
      : data;
  return {
    send(message) {
      const data = options.wrap === "pluginMessage" ? { pluginMessage: message } : message;
      window.parent.postMessage(data, "*");
    },
    listen(onMessage) {
      const handler = (event: MessageEvent) => {
        const data = unwrap(event.data);
        if (isPluginMessage(data)) onMessage(data);
      };
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    },
  };
}
