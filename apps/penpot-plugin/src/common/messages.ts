/**
 * Type-safe message passing between plugin (Penpot sandbox) and UI (iframe).
 *
 * Uses a discriminated union with factory functions and a typed handler map.
 * The plugin dispatches via `createMessageRouter()` — no switch statements.
 *
 * Key differences from Figma plugin:
 * - No SET_UI_OPTIONS (Penpot panel size is fixed at open time)
 * - No DELETE_VARIABLE (not needed for bridge use case)
 * - GET_LOCAL_VARIABLES → GET_DESIGN_TOKENS (Penpot terminology)
 * - SET_LOCAL_VARIABLE → SET_DESIGN_TOKEN (Penpot terminology)
 * - sendToUI uses penpot.ui.sendMessage() instead of figma.ui.postMessage()
 */

// ── Data models ─────────────────────────────────────────────────────

export type ColorValue = {
  r: number;
  g: number;
  b: number;
  a: number;
};

/** Represents a single bridgeable design token from Penpot */
export type DesignToken = {
  /** Unique path-based identifier (e.g., "colors/primary") */
  path: string;
  /** Display name (leaf segment of path) */
  name: string;
  /** Token type */
  type: "boolean" | "string" | "number" | "color";
  /** Current resolved value */
  value: boolean | string | number | ColorValue;
};

// ── Message type constants ──────────────────────────────────────────

export const MSG = {
  // Lifecycle
  UI_READY: "UI_READY",
  // Storage (localStorage in Penpot)
  GET_LOCAL_STATE: "GET_LOCAL_STATE",
  SET_LOCAL_STATE: "SET_LOCAL_STATE",
  // UI
  SHOW_TOAST: "SHOW_TOAST",
  OPEN_LINK: "OPEN_LINK",
  // Design Tokens
  GET_DESIGN_TOKENS: "GET_DESIGN_TOKENS",
  SET_DESIGN_TOKEN: "SET_DESIGN_TOKEN",
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

// ── Message shapes ──────────────────────────────────────────────────

interface MessageMap {
  [MSG.UI_READY]: undefined;
  [MSG.GET_LOCAL_STATE]: { key: string; value?: unknown };
  [MSG.SET_LOCAL_STATE]: { key: string; value?: unknown };
  [MSG.SHOW_TOAST]: { message: string };
  [MSG.OPEN_LINK]: string;
  [MSG.GET_DESIGN_TOKENS]: DesignToken[] | undefined;
  [MSG.SET_DESIGN_TOKEN]: { path: string; value: unknown };
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

function msg<T extends MessageType>(
  type: T,
  payload: MessageMap[T],
): Message<T> {
  return { type, payload };
}

export const messages = {
  uiReady: () => msg(MSG.UI_READY, undefined),

  getLocalState: (key: string, value?: unknown) =>
    msg(MSG.GET_LOCAL_STATE, { key, value }),

  setLocalState: (key: string, value: unknown) =>
    msg(MSG.SET_LOCAL_STATE, { key, value }),

  showToast: (message: string) => msg(MSG.SHOW_TOAST, { message }),

  openLink: (url: string) => msg(MSG.OPEN_LINK, url),

  getDesignTokens: (tokens?: DesignToken[]) =>
    msg(MSG.GET_DESIGN_TOKENS, tokens),

  setDesignToken: (path: string, value: unknown) =>
    msg(MSG.SET_DESIGN_TOKEN, { path, value }),
};

// ── Communication helpers ───────────────────────────────────────────

/** UI → Plugin (same as Figma: uses parent.postMessage) */
export function sendToPlugin(message: Message<MessageType>) {
  parent.postMessage(message, "*");
}

/** Plugin → UI (uses penpot.ui.sendMessage instead of figma.ui.postMessage) */
export function sendToUI(message: Message<MessageType>) {
  penpot.ui.sendMessage(message);
}

// ── Router factory for plugin sandbox ───────────────────────────────

/**
 * Creates a typed message router for the plugin sandbox.
 * Wraps each handler in try-catch so a single failure doesn't break the plugin.
 *
 * Can be passed directly to `penpot.ui.onMessage()` or used as a
 * window message event handler in the UI.
 */
export function createMessageRouter(handlers: MessageHandlers) {
  return (message: Message<MessageType>) => {
    const handler = handlers[message.type];
    if (!handler) {
      console.warn("[Plugin] Unhandled message type:", message.type);
      return;
    }

    try {
      const result = (handler as (p: unknown) => void | Promise<void>)(
        message.payload,
      );
      if (result instanceof Promise) {
        result.catch((err) => {
          console.error(
            `[Plugin] Async handler error for ${message.type}:`,
            err,
          );
        });
      }
    } catch (err) {
      console.error(`[Plugin] Handler error for ${message.type}:`, err);
    }
  };
}
