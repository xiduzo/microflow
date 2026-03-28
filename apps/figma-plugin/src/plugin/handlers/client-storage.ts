import { messages, sendToUI } from "../../common/messages";

export async function setLocalValue(key: string, value: unknown) {
  const current = await figma.clientStorage.getAsync(key);
  const merged = deepMerge(current, value);
  await figma.clientStorage.setAsync(key, merged);
  sendToUI(messages.setLocalState(key, merged));
}

export async function getLocalValue(key: string, fallback?: unknown) {
  const stored = await figma.clientStorage.getAsync(key);
  if (stored == null) {
    await figma.clientStorage.setAsync(key, fallback);
    sendToUI(messages.getLocalState(key, fallback));
    return;
  }
  sendToUI(messages.getLocalState(key, stored));
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

function deepMerge(current: unknown, incoming: unknown): unknown {
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
