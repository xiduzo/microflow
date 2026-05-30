import { useEffect, useMemo, useState } from "react";
import type { Credentials } from "@/lib/bindings/Credentials";
import type { MissingCredential } from "@/lib/bindings/MissingCredential";
import { checkCredentials } from "@/lib/codegen";
import { useFlowSession, useFlowMeta } from "@/session";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  CREDENTIAL_FIELDS,
  emptyCredentials,
  fieldDisplayValue,
  formatMissingWarning,
  isSecretField,
  setCredentialField,
  type CredentialFieldKey,
} from "./credentials-surface.model";

/**
 * Network-credential configuration surface (Task #46, Feature #27).
 *
 * Lets the Flow Author enter the credentials a Cloud-capable Sketch uses to
 * connect on boot — WiFi SSID/password, MQTT broker host/port/auth, LLM
 * endpoint/API key — with secret fields masked, and warns when required
 * credentials are missing for the current Flow + board target.
 *
 * ## Storage (explicit, deliberate)
 *
 * Credentials live in **session-only** React state. They are passed per
 * generation via `onChange` (the parent threads them into `generate_sketch`)
 * and are **never** written to the Flow document — unlike the board-target
 * selection — so secrets are not persisted in the Flow in plaintext. Re-opening
 * the Flow starts with empty credentials by design.
 *
 * The surface only renders when a Cloud-capable generation is possible (the
 * board target offers networking and the Flow has Cloud Nodes); otherwise the
 * credentials are irrelevant and it stays hidden.
 */
export function CredentialsSurface({
  credentials,
  onChange,
}: {
  /** Current session credentials (held by the parent so generation can read them). */
  credentials: Credentials;
  /** Called with the updated credentials whenever the Author edits a field. */
  onChange: (next: Credentials) => void;
}) {
  const { doc, readOnly } = useFlowSession();
  const meta = useFlowMeta(doc);
  const [missing, setMissing] = useState<MissingCredential[]>([]);

  const flow = useMemo(() => ({ nodes: doc.getNodes(), edges: doc.getEdges() }), [doc]);

  // Recompute which credentials are missing whenever the inputs, the Flow, or
  // the selected target change, so the warning is specific and current. The
  // backend never logs secret values.
  useEffect(() => {
    let cancelled = false;
    void checkCredentials(flow, meta.selectedTargetId ?? undefined, credentials).then((m) => {
      if (!cancelled) setMissing(m);
    });
    return () => {
      cancelled = true;
    };
  }, [flow, meta.selectedTargetId, credentials]);

  const warning = formatMissingWarning(missing);

  const handleField = (key: CredentialFieldKey) => (value: string) => {
    if (readOnly) return;
    onChange(setCredentialField(credentials, key, value));
  };

  return (
    <section aria-label="Network credentials" className="flex flex-col gap-3">
      <h2 className="text-xs font-medium">Network credentials</h2>

      {warning !== undefined && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Missing credentials</AlertTitle>
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        {CREDENTIAL_FIELDS.map((field) => {
          const inputId = `credential-${field.key}`;
          const secret = isSecretField(field.key);
          return (
            <div key={field.key} className="flex flex-col gap-1">
              <Label htmlFor={inputId}>{field.label}</Label>
              <Input
                id={inputId}
                name={field.key}
                type={secret ? "password" : field.numeric ? "number" : "text"}
                inputMode={field.numeric ? "numeric" : undefined}
                autoComplete={secret ? "off" : undefined}
                aria-label={field.label}
                disabled={readOnly}
                value={fieldDisplayValue(credentials, field.key)}
                onChange={(e) => handleField(field.key)(e.currentTarget.value)}
              />
            </div>
          );
        })}
      </div>

      <p className="text-muted-foreground text-[10px]">
        Credentials are kept for this session only and are never saved into the Flow.
      </p>
    </section>
  );
}

/** A session-only credentials store hook for callers that own generation. */
export function useSessionCredentials(): [Credentials, (next: Credentials) => void] {
  return useState<Credentials>(emptyCredentials);
}
