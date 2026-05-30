import { describe, expect, test } from "bun:test";
import type { MissingCredential } from "@/lib/bindings/MissingCredential";
import {
  CREDENTIAL_FIELDS,
  emptyCredentials,
  fieldDisplayValue,
  formatMissingWarning,
  hasMissingCredentials,
  isSecretField,
  setCredentialField,
} from "../credentials-surface.model";

describe("credentials surface model", () => {
  // Scenario: Secret fields are masked.
  // The surface masks a field iff the model marks it secret; password and API
  // key fields are secret, plain identifiers are not.
  test("password and API-key fields are flagged secret; identifiers are not", () => {
    expect(isSecretField("wifiPassword")).toBe(true);
    expect(isSecretField("brokerPassword")).toBe(true);
    expect(isSecretField("llmApiKey")).toBe(true);

    expect(isSecretField("wifiSsid")).toBe(false);
    expect(isSecretField("brokerHost")).toBe(false);
    expect(isSecretField("llmEndpoint")).toBe(false);
  });

  test("every secret field has a label and is covered by the field table", () => {
    const secretCount = CREDENTIAL_FIELDS.filter((f) => f.secret).length;
    expect(secretCount).toBe(3);
    for (const field of CREDENTIAL_FIELDS) {
      expect(field.label.length).toBeGreaterThan(0);
    }
  });

  test("empty credentials start blank with a zero broker port", () => {
    const creds = emptyCredentials();
    expect(creds.wifiSsid).toBe("");
    expect(creds.wifiPassword).toBe("");
    expect(creds.brokerPort).toBe(0);
  });

  test("editing a text field updates only that field", () => {
    const next = setCredentialField(emptyCredentials(), "wifiSsid", "studio-net");
    expect(next.wifiSsid).toBe("studio-net");
    expect(next.wifiPassword).toBe("");
  });

  test("broker port coerces to a number, defaulting to 0 when blank or invalid", () => {
    expect(setCredentialField(emptyCredentials(), "brokerPort", "8883").brokerPort).toBe(8883);
    expect(setCredentialField(emptyCredentials(), "brokerPort", "").brokerPort).toBe(0);
    expect(setCredentialField(emptyCredentials(), "brokerPort", "abc").brokerPort).toBe(0);
  });

  test("a zero broker port displays as empty so the placeholder shows", () => {
    expect(fieldDisplayValue(emptyCredentials(), "brokerPort")).toBe("");
    const withPort = setCredentialField(emptyCredentials(), "brokerPort", "1883");
    expect(fieldDisplayValue(withPort, "brokerPort")).toBe("1883");
  });

  // Scenario: Missing credentials warn the Author.
  // The warning names each missing field by its human label so the Author knows
  // exactly what to supply — and never echoes a secret value.
  test("missing-credential warning names each missing field by label", () => {
    const missing: MissingCredential[] = [
      { field: "wifiSsid", reason: "Cloud Nodes need a WiFi network to join on boot" },
      { field: "wifiPassword", reason: "Cloud Nodes need the WiFi password to join on boot" },
    ];
    const warning = formatMissingWarning(missing);
    expect(warning).toBeDefined();
    expect(warning).toContain("WiFi SSID");
    expect(warning).toContain("WiFi password");
    expect(hasMissingCredentials(missing)).toBe(true);
  });

  test("no missing credentials produces no warning", () => {
    expect(formatMissingWarning([])).toBeUndefined();
    expect(hasMissingCredentials([])).toBe(false);
  });

  test("warning falls back to the raw field name for an unknown key", () => {
    const warning = formatMissingWarning([{ field: "somethingNew", reason: "r" }]);
    expect(warning).toContain("somethingNew");
  });
});
