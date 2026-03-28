/**
 * Type-safe message passing between plugin (Figma sandbox) and UI (iframe).
 *
 * Uses a discriminated union with factory functions and a typed handler map.
 * The plugin dispatches via `createMessageRouter()` — no switch statements.
 */

// ── Message type constants ──────────────────────────────────────────
export const MSG = {
  // Lifecycle
  UI_READY: "UI_READY",
  // Client storage
  GET_LOCAL_STATE: "GET_LOCAL_STATE",
  SET_LOCAL_STATE: "SET_LOCAL_STATE",
  // UI
  SET_UI_OPTIONS: "SET_UI_OPTIONS",
  SHOW_TOAST: "SHOW_TOAST",
  OPEN_LINK: "OPEN_LINK",
  // Variables
  GET_LOCAL_VARIABLES: "GET_LOCAL_VARIABLES",
  SET_LOCAL_VARIABLE: "SET_LOCAL_VARIABLE",
  DELETE_VARIABLE: "DELETE_VARIABLE",
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

// ── Payload types ───────────────────────────────────────────────────

export type PickedVariable = Pick<Variable, "id" | "name" | "resolvedType">;
export type FullVariable = PickedVariable &
  Pick<Variable, "description" | "valuesByMode">;

// ── Message shapes ──────────────────────────────────────────────────

interface MessageMap {
  [MSG.UI_READY]: undefined;
  [MSG.GET_LOCAL_STATE]: { key: string; value?: unknown };
  [MSG.SET_LOCAL_STATE]: { key: string; value?: unknown };
  [MSG.SET_UI_OPTIONS]: { width?: number; height?: number };
  [MSG.SHOW_TOAST]: { message: string; options?: NotificationOptions };
  [MSG.OPEN_LINK]: string;
  [MSG.GET_LOCAL_VARIABLES]: FullVariable[] | undefined;
  [MSG.SET_LOCAL_VARIABLE]: { id: string; value: unknown };
  [MSG.DELETE_VARIABLE]: string;
}

export type Message<T extends MessageType = MessageType> = {
  type: T;
  payload: MessageMap[T];
};

/**
 * Handler map type — ensures every handler receives the correct payload type.
 * Used by `createMessageRouter()` in the plugin sandbox.
 */
export type MessageHandlers = {
  [K in MessageType]?: (payload: MessageMap[K]) => void | Promise<void>;
};

// ── Factory functions ───────────────────────────────────────────────

function msg<T extends MessageType>(type: T, payload: MessageMap[T]): Message<T> {
  return { type, payload };
}

export const messages = {
  uiReady: () => msg(MSG.UI_READY, undefined),

  getLocalState: (key: string, value?: unknown) =>
    msg(MSG.GET_LOCAL_STATE, { key, value }),

  setLocalState: (key: string, value: unknown) =>
    msg(MSG.SET_LOCAL_STATE, { key, value }),

  setUiOptions: (opts: { width?: number; height?: number }) =>
    msg(MSG.SET_UI_OPTIONS, opts),

  showToast: (message: string, options?: NotificationOptions) =>
    msg(MSG.SHOW_TOAST, { message, options }),

  openLink: (url: string) => msg(MSG.OPEN_LINK, url),

  getLocalVariables: (variables?: FullVariable[]) =>
    msg(MSG.GET_LOCAL_VARIABLES, variables),

  setLocalVariable: (id: string, value: unknown) =>
    msg(MSG.SET_LOCAL_VARIABLE, { id, value }),

  deleteVariable: (id: string) => msg(MSG.DELETE_VARIABLE, id),
};

// ── Communication helpers ───────────────────────────────────────────

/** UI → Plugin */
export function sendToPlugin(message: Message<MessageType>) {
  parent.postMessage({ pluginMessage: message }, "*");
}

/** Plugin → UI (typed wrapper around figma.ui.postMessage) */
export function sendToUI(message: Message<MessageType>) {
  figma.ui.postMessage(message);
}

export type PluginMessageEvent = MessageEvent<{
  pluginMessage: { type: MessageType; payload?: unknown };
}>;

// ── Router factory for plugin sandbox ───────────────────────────────

/**
 * Creates a typed message router for the plugin sandbox.
 * Wraps each handler in try-catch so a single failure doesn't break the plugin.
 */
export function createMessageRouter(handlers: MessageHandlers) {
  return (message: Message<MessageType>) => {
    const handler = handlers[message.type];
    if (!handler) {
      console.warn("[Plugin] Unhandled message type:", message.type);
      return;
    }

    try {
      const result = (handler as (p: unknown) => void | Promise<void>)(message.payload);
      if (result instanceof Promise) {
        result.catch((err) => {
          console.error(`[Plugin] Async handler error for ${message.type}:`, err);
          figma.notify(`Error: ${message.type} failed`, { error: true });
        });
      }
    } catch (err) {
      console.error(`[Plugin] Handler error for ${message.type}:`, err);
      figma.notify(`Error: ${message.type} failed`, { error: true });
    }
  };
}
