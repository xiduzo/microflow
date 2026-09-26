/**
 * The Bridge ID pairs a design-tool plugin with Studio: both use it as the
 * `{uid}` topic segment, so they must hold the same value. Studio and both
 * plugins validate it with the same rule.
 */

const BRIDGE_ID = /^[A-Za-z0-9_-]{5,64}$/;

/** An error message for an invalid Bridge ID, or `null` when it is valid. */
export function validateBridgeId(id: string): string | null {
  if (id.length < 5) return "Use at least 5 characters";
  if (id.length > 64) return "Use at most 64 characters";
  if (!BRIDGE_ID.test(id)) return "Use only letters, digits, - and _";
  return null;
}

export function isValidBridgeId(id: string): boolean {
  return validateBridgeId(id) === null;
}

const ADJECTIVES = ["swift", "bright", "calm", "bold", "keen", "warm", "cool", "wild"];
const ANIMALS = ["fox", "owl", "bear", "wolf", "hawk", "deer", "lynx", "seal"];

/** A random, readable Bridge ID such as `calm_lynx_4821`. */
export function randomBridgeId(random: () => number = Math.random): string {
  const pick = (list: string[]) => list[Math.floor(random() * list.length)]!;
  const digits = Math.floor(random() * 10_000)
    .toString()
    .padStart(4, "0");
  return `${pick(ADJECTIVES)}_${pick(ANIMALS)}_${digits}`;
}

/**
 * A Bridge ID derived from a display name: characters outside the allowed set
 * become `_`. Returns `null` when too little of the name is left.
 */
export function bridgeIdFromName(name: string): string | null {
  const id = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return isValidBridgeId(id) ? id : null;
}
