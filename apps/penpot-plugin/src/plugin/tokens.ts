/**
 * Penpot's side of the design bridge: the tokens of the "MHB" set, read as
 * bridge variables and written back from bridge values.
 */
import {
  type BridgeColor,
  type BridgeSnapshotEntry,
  type BridgeValue,
  type ResolvedType,
  colorToHex,
  toColor,
  toFloat,
  toText,
} from "@microflow/design-bridge";
import type { Token, TokenSet } from "@penpot/plugin-types";

export const SET_NAME = "MHB";

/** Penpot has no boolean token type. Composite tokens are not bridged. */
const BRIDGE_TYPES: Record<Token["type"], ResolvedType | null> = {
  color: "COLOR",
  number: "FLOAT",
  dimension: "FLOAT",
  opacity: "FLOAT",
  rotation: "FLOAT",
  sizing: "FLOAT",
  spacing: "FLOAT",
  borderWidth: "FLOAT",
  borderRadius: "FLOAT",
  fontSizes: "FLOAT",
  letterSpacing: "FLOAT",
  fontWeights: "STRING",
  fontFamilies: "STRING",
  textCase: "STRING",
  textDecoration: "STRING",
  shadow: null,
  typography: null,
};

let createdSet = false;

/** The "MHB" set, created (active) the first time it is missing. */
export function bridgeSet(): TokenSet | undefined {
  const catalog = penpot.library.local.tokens;
  const set = catalog.sets.find(({ name }) => name === SET_NAME);
  if (set || createdSet) return set;
  // `addSet` reaches the catalog asynchronously; creating it once avoids duplicates.
  createdSet = true;
  return catalog.addSet({ name: SET_NAME, active: true });
}

export function snapshot(): BridgeSnapshotEntry[] {
  const entries: BridgeSnapshotEntry[] = [];
  for (const token of bridgeSet()?.tokens ?? []) {
    const entry = readToken(token);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function readToken(token: Token): BridgeSnapshotEntry | null {
  const resolvedType = BRIDGE_TYPES[token.type];
  if (!resolvedType) return null;
  const value = readValue(token, resolvedType);
  if (value === null) return null;
  return { variable: { id: token.id, name: token.name, resolvedType }, value };
}

function readValue(token: Token, type: ResolvedType): BridgeValue | null {
  // `null` when the set is inactive, `undefined` when the value does not resolve.
  const resolved: unknown = token.resolvedValue;
  if (resolved == null) return null;
  switch (type) {
    case "COLOR":
      return readColor(token.value, resolved);
    case "FLOAT":
      return toFloat(resolved);
    case "STRING":
      return token.type === "fontFamilies" ? joinFontFamilies(resolved) : toText(resolved);
    case "BOOLEAN":
      return null;
  }
}

/**
 * Penpot resolves colors without their alpha. When the token's own value is the
 * color that resolved, take the alpha from it.
 */
function readColor(own: unknown, resolved: unknown): BridgeColor | null {
  const color = toColor(resolved);
  if (!color) return null;
  const literal = toColor(own);
  return literal && colorToHex({ ...literal, a: 1 }) === colorToHex(color) ? literal : color;
}

/** Penpot resolves a multi-word family such as "IBM Plex Mono" to `["IBM", "Plex", "Mono"]`. */
function joinFontFamilies(resolved: unknown): string | null {
  if (typeof resolved === "string") return resolved;
  if (!Array.isArray(resolved)) return null;
  return resolved
    .map((family: unknown) => (Array.isArray(family) ? family.join(" ") : String(family)))
    .join(", ");
}

/** The token value to store for a bridge value, or `null` when it does not fit the token. */
export function tokenValue(token: Token, value: BridgeValue): string | null {
  switch (BRIDGE_TYPES[token.type]) {
    case "COLOR": {
      const color = toColor(value);
      return color && colorToHex(color);
    }
    case "FLOAT": {
      const number = toFloat(value);
      return number === null ? null : String(number);
    }
    case "STRING":
      return toText(value);
    default:
      return null;
  }
}
