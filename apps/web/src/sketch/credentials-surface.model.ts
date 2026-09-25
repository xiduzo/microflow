import type { Credentials } from "@/lib/bindings/Credentials";
import type { MissingCredential } from "@/lib/bindings/MissingCredential";

/**
 * Network-credential configuration surface — pure logic (Task #46, Feature #27).
 *
 * A Cloud-capable Sketch (Cloud Nodes on a WiFi-capable board) connects to the
 * network on boot using credentials the Flow Author supplies here. This module
 * holds the field metadata and the projection logic the surface and its tests
 * share; the React component is a thin shell over it.
 *
 * ## Storage decision (explicit)
 *
 * Credentials are **session-only**: held in component state and passed per
 * generation into `generate_sketch`. They are **never** written to the Flow
 * document (unlike the board-target selection) so secrets are not persisted in
 * the Flow in plaintext. This is the deliberate trade-off the Feature calls for
 * — convenience (re-entry each session) in exchange for not storing secrets.
 */

/** A field of the {@link Credentials} payload presented in the surface. */
export type CredentialFieldKey = keyof Credentials;

/** Metadata describing how a credential field is presented and validated. */
export type CredentialFieldSpec = {
  /** The {@link Credentials} field this input binds to. */
  key: CredentialFieldKey;
  /** Human-readable label (accessibility: the input's accessible name). */
  label: string;
  /** True for secret fields (password, API key) — masked in the UI. */
  secret: boolean;
  /** Input type hint: numeric for the broker port, otherwise text. */
  numeric?: boolean;
  /** Logical grouping for sectioned layout. */
  group: "wifi" | "broker" | "llm";
};

/**
 * The credential fields, in display order. Secret fields are flagged so the
 * surface masks them; the missing-credential check (backend `check_credentials`)
 * names fields by these same keys.
 */
export const CREDENTIAL_FIELDS: readonly CredentialFieldSpec[] = [
  { key: "wifiSsid", label: "WiFi SSID", secret: false, group: "wifi" },
  { key: "wifiPassword", label: "WiFi password", secret: true, group: "wifi" },
  { key: "brokerHost", label: "MQTT broker host", secret: false, group: "broker" },
  { key: "brokerPort", label: "MQTT broker port", secret: false, numeric: true, group: "broker" },
  { key: "brokerUsername", label: "MQTT username", secret: false, group: "broker" },
  { key: "brokerPassword", label: "MQTT password", secret: true, group: "broker" },
  { key: "llmEndpoint", label: "LLM endpoint", secret: false, group: "llm" },
  { key: "llmApiKey", label: "LLM API key", secret: true, group: "llm" },
] as const;

/** The set of secret field keys, derived from {@link CREDENTIAL_FIELDS}. */
export const SECRET_FIELDS: ReadonlySet<CredentialFieldKey> = new Set(
  CREDENTIAL_FIELDS.filter((f) => f.secret).map((f) => f.key),
);

/** True when `key` names a secret field that must be masked in the UI. */
export function isSecretField(key: CredentialFieldKey): boolean {
  return SECRET_FIELDS.has(key);
}

/**
 * The empty credentials payload — every field blank, broker port 0 (the backend
 * defaults it to 1883 in the emitted Sketch). Used as the initial session state.
 */
export function emptyCredentials(): Credentials {
  return {
    wifiSsid: "",
    wifiPassword: "",
    brokerHost: "",
    brokerPort: 0,
    brokerUsername: "",
    brokerPassword: "",
    llmEndpoint: "",
    llmApiKey: "",
  };
}

/**
 * Apply an edit to one credential field, returning a new payload. The broker
 * port is coerced to a number (0 when blank/invalid) since the input yields a
 * string; all other fields are stored verbatim.
 */
export function setCredentialField(
  credentials: Credentials,
  key: CredentialFieldKey,
  value: string,
): Credentials {
  if (key === "brokerPort") {
    const parsed = Number.parseInt(value, 10);
    return { ...credentials, brokerPort: Number.isNaN(parsed) ? 0 : parsed };
  }
  return { ...credentials, [key]: value };
}

/**
 * The display value for a field's input. Numeric fields render `0` as an empty
 * string so the placeholder shows rather than a literal zero; all other fields
 * render their string value.
 */
export function fieldDisplayValue(credentials: Credentials, key: CredentialFieldKey): string {
  if (key === "brokerPort") {
    return credentials.brokerPort === 0 ? "" : String(credentials.brokerPort);
  }
  const value = credentials[key];
  return typeof value === "string" ? value : String(value);
}

/**
 * Format a one-line warning summarising the missing credentials, naming each
 * field so the Author knows exactly what to supply. Returns `undefined` when
 * nothing is missing (no warning to show). Never echoes a secret value — only
 * field labels and the backend-provided reasons (which carry no secrets).
 */
export function formatMissingWarning(missing: MissingCredential[]): string | undefined {
  if (missing.length === 0) return undefined;
  const labelFor = (field: string): string =>
    CREDENTIAL_FIELDS.find((f) => f.key === field)?.label ?? field;
  const names = missing.map((m) => labelFor(m.field)).join(", ");
  return `Missing required credentials: ${names}`;
}

/** True when there are missing credentials to warn about. */
export function hasMissingCredentials(missing: MissingCredential[]): boolean {
  return missing.length > 0;
}
