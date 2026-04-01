/**
 * Storage handlers for the Penpot plugin sandbox.
 *
 * Unlike Figma's `clientStorage` (async KV store in the sandbox), Penpot grants
 * `localStorage` access directly in the UI iframe via the `allow:localstorage`
 * permission. The sandbox simply relays GET/SET messages back to the UI — it acts
 * as a pass-through to keep the message protocol consistent with the Figma plugin.
 *
 * The `deepMerge` utility is exported so the UI can import it for merging partial
 * state updates into existing localStorage data.
 */
import { messages, sendToUI } from "../../common/messages";

// ── Sandbox handlers (relay to UI) ─────────────────────────────────

/**
 * Relay a GET_LOCAL_STATE request back to the UI.
 * The UI will read from localStorage and use the provided fallback value
 * if no stored value exists.
 */
export async function getLocalState(
  key: string,
  value?: unknown,
): Promise<void> {
  sendToUI(messages.getLocalState(key, value));
}

/**
 * Relay a SET_LOCAL_STATE request back to the UI.
 * The UI will write the value to localStorage.
 */
export async function setLocalState(
  key: string,
  value: unknown,
): Promise<void> {
  sendToUI(messages.setLocalState(key, value));
}

// ── Deep merge utility ──────────────────────────────────────────────

function tryParse(val: unknown): unknown {
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

/**
 * Recursively merges `incoming` into `current`.
 *
 * - Plain objects are merged key-by-key (incoming wins for leaf values).
 * - `null` values in incoming are skipped (treated as "no change").
 * - JSON strings are parsed before merging and re-serialized if the
 *   incoming value was originally a string.
 * - Non-object values are replaced outright.
 */
export function deepMerge(current: unknown, incoming: unknown): unknown {
  const parsedCurrent = tryParse(current);
  const parsedIncoming = tryParse(incoming);
  const wasString = typeof incoming === "string";

  if (isPlainObject(parsedCurrent) && isPlainObject(parsedIncoming)) {
    const merged: Record<string, unknown> = { ...parsedCurrent };
    for (const key of Object.keys(parsedIncoming)) {
      const incomingVal = parsedIncoming[key];
      if (incomingVal === null) continue;
      const currentVal = merged[key];
      merged[key] =
        isPlainObject(currentVal) && isPlainObject(incomingVal)
          ? deepMerge(currentVal, incomingVal)
          : incomingVal;
    }
    return wasString ? JSON.stringify(merged) : merged;
  }

  return incoming;
}
