/**
 * Design token handler for the Penpot plugin sandbox.
 *
 * Reads native design tokens from the local Penpot library via the
 * TokenCatalog API (available since @penpot/plugin-types v1.3+).
 *
 * Looks for a token set named "MHB" first (mirroring the Figma plugin's
 * variable collection). Falls back to all active token sets if no MHB set
 * exists.
 *
 * Mirrors the Figma plugin's `variables.ts` handler, adapted for Penpot.
 */
import {
  type ColorValue,
  type DesignToken,
  messages,
  sendToUI,
} from "../../common/messages";

const SET_NAME = "MHB";

// ── Token types that resolve to a number ────────────────────────────

const NUMERIC_TOKEN_TYPES = new Set([
  "number",
  "dimension",
  "opacity",
  "rotation",
  "sizing",
  "spacing",
  "borderWidth",
  "borderRadius",
  "fontSizes",
  "fontWeights",
  "letterSpacing",
]);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Reads all bridgeable design tokens from the local Penpot library,
 * flattens them into a list, and sends them to the UI.
 */
export function getDesignTokens(): void {
  try {
    const catalog = penpot.library.local.tokens;
    const sets = catalog.sets;

    // Ensure the MHB set exists, create it if missing
    let mhbSet = sets.find((s) => s.name === SET_NAME);
    if (!mhbSet) {
      mhbSet = catalog.addSet({ name: SET_NAME });
      // Activate the newly created set so it appears in the Penpot UI
      if (!mhbSet.active) mhbSet.toggleActive();
    }
    const targetSets = [mhbSet];

    const tokens: DesignToken[] = [];

    for (const set of targetSets) {
      for (const token of set.tokens) {
        const mapped = mapToken(token, set.name);
        if (mapped) tokens.push(mapped);
      }
    }

    console.log(tokens[0])

    sendToUI(messages.getDesignTokens(tokens));
  } catch (err) {
    console.error("[design-tokens] Failed to read tokens:", err);
    sendToUI(messages.getDesignTokens([]));
  }
}

/**
 * Updates a design token value in the local Penpot library.
 * Finds the token by name across the MHB set (or active sets),
 * then writes the new value string back.
 */
export function setDesignToken(path: string, value: unknown): void {
  try {
    const catalog = penpot.library.local.tokens;
    const sets = catalog.sets;
    let mhbSet = sets.find((s) => s.name === SET_NAME);
    if (!mhbSet) {
      mhbSet = catalog.addSet({ name: SET_NAME });
      if (!mhbSet.active) mhbSet.toggleActive();
    }
    const targetSets = [mhbSet];

    // Find the token by name (path) across target sets
    let found: { type: string; value: string } | undefined;
    for (const set of targetSets) {
      const token = set.tokens.find((t) => t.name === path);
      if (token) {
        found = token;
        break;
      }
    }

    if (!found) {
      console.warn("[design-tokens] Token not found:", path);
      return;
    }

    // Convert incoming value to a string that Penpot can store
    const strValue = toTokenValueString(found.type, value);
    if (strValue === null) {
      sendToUI(
        messages.showToast(
          `Invalid value (${String(value)}) for token "${path}"`,
        ),
      );
      return;
    }

    found.value = strValue;
  } catch (err) {
    console.error("[design-tokens] Failed to set token:", err);
  }
}

// ── Token mapping ───────────────────────────────────────────────────

/**
 * Maps a Penpot Token to our bridgeable DesignToken format.
 * Returns null for token types we can't bridge (typography, shadow, etc.).
 */
function mapToken(
  token: { name: string; type: string; resolvedValueString?: string },
  setName: string,
): DesignToken | null {
  const resolved = token.resolvedValueString;
  if (resolved === undefined) return null;

  const path = setName !== SET_NAME ? `${setName}/${token.name}` : token.name;
  const leaf = token.name.split(".").pop() ?? token.name;

  if (token.type === "color") {
    const rgba = hexToRgba(resolved, 1);
    if (!rgba) return null;
    return { path, name: leaf, type: "color", value: rgba };
  }

  if (NUMERIC_TOKEN_TYPES.has(token.type)) {
    const num = parseFloat(resolved);
    if (isNaN(num)) return null;
    return { path, name: leaf, type: "number", value: num };
  }

  // Everything else (fontFamilies, textCase, textDecoration) → string
  return { path, name: leaf, type: "string", value: resolved };
}

// ── Value conversion for writing back ───────────────────────────────

/**
 * Converts an incoming MQTT/bridge value to a Penpot token value string.
 */
function toTokenValueString(tokenType: string, value: unknown): string | null {
  if (tokenType === "color") {
    const rgba = toRgbaOrNull(value);
    return rgba ? rgbaToHex(rgba) : null;
  }

  if (NUMERIC_TOKEN_TYPES.has(tokenType)) {
    const num = toFloatOrNull(value);
    return num !== null ? String(num) : null;
  }

  // String-like tokens
  return value != null ? String(value) : null;
}

// ── Value type mapping ──────────────────────────────────────────────

export function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string")
    return ["true", "yes", "1", "si", "on"].includes(value.toLowerCase());
  if (typeof value === "number") return value === 1;
  return null;
}

export function toFloatOrNull(value: unknown): number | null {
  const str = String(value).replace(",", ".");
  const float = parseFloat(str);
  if (isNaN(float)) {
    const bool = toBooleanOrNull(str);
    return bool !== null ? Number(bool) : null;
  }
  const int = parseInt(str);
  if (isNaN(int)) return null;
  return float > int ? float : int;
}

export function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  return null;
}

export function toRgbaOrNull(value: unknown): ColorValue | null {
  try {
    if (typeof value === "string") {
      return hexToRgba(value, 1);
    }
    if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, unknown>;
      const r = toFloatOrNull(obj.r);
      const g = toFloatOrNull(obj.g);
      const b = toFloatOrNull(obj.b);
      if (r === null || g === null || b === null) return null;
      const a = obj.a !== undefined ? toFloatOrNull(obj.a) : 1;
      return { r, g, b, a: a ?? 1 };
    }
  } catch {
    // fall through
  }
  return null;
}

// ── Color conversion helpers ────────────────────────────────────────

function hexToRgba(hex: string, opacity: number): ColorValue | null {
  const cleaned = hex.replace("#", "");
  let r: number;
  let g: number;
  let b: number;
  let a = opacity;

  if (cleaned.length === 3) {
    r = parseInt(cleaned.charAt(0) + cleaned.charAt(0), 16);
    g = parseInt(cleaned.charAt(1) + cleaned.charAt(1), 16);
    b = parseInt(cleaned.charAt(2) + cleaned.charAt(2), 16);
  } else if (cleaned.length === 6) {
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
  } else if (cleaned.length === 8) {
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
    a = parseInt(cleaned.slice(6, 8), 16) / 255;
  } else {
    return null;
  }

  if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) return null;
  return { r, g, b, a };
}

function rgbaToHex(rgba: ColorValue): string {
  const toHex = (n: number) =>
    Math.round(Math.max(0, Math.min(255, n)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(rgba.r)}${toHex(rgba.g)}${toHex(rgba.b)}`;
}
