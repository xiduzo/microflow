/**
 * Value coercion shared by both plugins and mirrored by Studio's Rust runtime
 * (`crates/microflow-core/src/design_bridge.rs`). Both are checked against
 * `fixtures/protocol.json`.
 *
 * A payload is decoded as JSON when it parses, and used as text otherwise; the
 * result is then coerced to the variable's type. Coercion returns `null` for a
 * value that does not fit the type, and the caller drops it.
 */
import type { BridgeColor, BridgeValue, ResolvedType } from "./protocol";

const TRUE_WORDS = new Set(["true", "yes", "on", "1", "si"]);
const FALSE_WORDS = new Set(["false", "no", "off", "0", ""]);

/** Decode a raw MQTT payload: JSON when it parses, the text itself otherwise. */
export function decodePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Encode a value for the wire. Color channels are snapped to 8 bits (what
 * Penpot's hex and Studio's channels hold), so a color survives a round trip
 * through any tool unchanged and is not published back as an echo.
 */
export function encodeValue(value: BridgeValue): string {
  if (typeof value === "object") {
    return JSON.stringify({
      r: channel(value.r),
      g: channel(value.g),
      b: channel(value.b),
      a: channel(value.a),
    });
  }
  return JSON.stringify(value);
}

export function coerce(type: ResolvedType, value: unknown): BridgeValue | null {
  switch (type) {
    case "BOOLEAN":
      return toBoolean(value);
    case "FLOAT":
      return toFloat(value);
    case "STRING":
      return toText(value);
    case "COLOR":
      return toColor(value);
  }
}

export function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : null;
  if (typeof value !== "string") return null;
  const word = value.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  const number = toFloat(word);
  return number === null ? null : number !== 0;
}

export function toFloat(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(",", ".");
  if (text === "") return null;
  const exact = Number(text);
  if (Number.isFinite(exact)) return exact;
  // Allow a unit suffix such as `12px` or `90deg`.
  const leading = Number.parseFloat(text);
  if (Number.isFinite(leading)) return leading;
  const word = text.toLowerCase();
  if (TRUE_WORDS.has(word)) return 1;
  if (FALSE_WORDS.has(word)) return 0;
  return null;
}

export function toText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * Accepts `{r, g, b, a?}` with channels 0–1, a hex string (`#rgb`, `#rgba`,
 * `#rrggbb`, `#rrggbbaa`, `#` optional) or CSS `rgb()` / `rgba()`.
 */
export function toColor(value: unknown): BridgeColor | null {
  if (typeof value === "string") return parseColorString(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { r, g, b, a } = value as Record<string, unknown>;
  const channels = [r, g, b, a ?? 1].map(toFloat);
  if (channels.some((c) => c === null)) return null;
  const [cr, cg, cb, ca] = channels as [number, number, number, number];
  return { r: clamp01(cr), g: clamp01(cg), b: clamp01(cb), a: clamp01(ca) };
}

export function hexToColor(hex: string): BridgeColor | null {
  const clean = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-f]+$/i.test(clean)) return null;
  const expand = clean.length <= 4 ? clean.replace(/./g, "$&$&") : clean;
  if (expand.length !== 6 && expand.length !== 8) return null;
  const byte = (i: number) => Number.parseInt(expand.slice(i, i + 2), 16) / 255;
  return { r: byte(0), g: byte(2), b: byte(4), a: expand.length === 8 ? byte(6) : 1 };
}

/** `#rrggbb`, or `#rrggbbaa` when the color is not fully opaque. */
export function colorToHex(color: BridgeColor): string {
  const byte = (c: number) =>
    Math.round(clamp01(c) * 255)
      .toString(16)
      .padStart(2, "0");
  const alpha = color.a < 1 ? byte(color.a) : "";
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${alpha}`;
}

function parseColorString(text: string): BridgeColor | null {
  const css = /^rgba?\(\s*([^)]+)\)$/i.exec(text.trim());
  if (!css?.[1]) return hexToColor(text);
  const parts = css[1].split(/[\s,/]+/).filter(Boolean).map(toFloat);
  if (parts.length < 3 || parts.length > 4 || parts.some((p) => p === null)) return null;
  const [r, g, b, a = 1] = parts as number[];
  return {
    r: clamp01(r! / 255),
    g: clamp01(g! / 255),
    b: clamp01(b! / 255),
    a: clamp01(a),
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function channel(n: number): number {
  return Math.round((Math.round(clamp01(n) * 255) / 255) * 10_000) / 10_000;
}
