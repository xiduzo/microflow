// Reachability probes for the cloud config pages.
//
// For MQTT this is browser-only: the desktop host owns live connections and
// pushes their state back as "mqtt-broker-status", while the browser opens
// connections lazily in the CloudPerformer, so nothing ever set a status and
// every broker read as "never connected".
//
// For LLM it runs in both hosts. Since ADR-0021 there is one transport, so there
// is one probe — `llm_test_provider` (a Rust command) is gone, and the status
// dot is now answered by the same code path a generation takes.
//
// Either way: a short-lived probe per config entry, answering only "is this
// endpoint reachable from HERE?". They never touch the runtime's own
// connections.

import mqtt from "mqtt";
import type { ConnectionStatus, MqttBrokerConfig } from "@/stores/mqtt-broker";
import type { LlmProviderConfig, ProviderStatus } from "@/stores/llm-provider";
import { isBrowserReachableBroker } from "@/components/flow/nodes/_base/browser-support";
import { hostFetch, isMixedContent, normalizeBaseUrl } from "@/lib/ai/endpoint";

const PROBE_TIMEOUT_MS = 8000;

/**
 * Why a provider probe ended as it did.
 *
 * The probe is the only place that sees the real failure — a thrown `fetch`, a
 * 401, a mixed-content block — so it says which, rather than collapsing every
 * one to `"error"` and leaving the page to guess from the URL. A bad API key
 * and a CORS refusal need different fixes and must not share a sentence.
 */
export type LlmProbeOutcome =
  | { kind: "ok" }
  /** An `http://` endpoint on an `https://` page; the request never went out. */
  | { kind: "mixedContent" }
  /** `fetch` threw: CORS refusal, DNS failure, connection refused, or timeout. */
  | { kind: "unreachable" }
  /** The endpoint answered and rejected us — a bad key, a wrong path. */
  | { kind: "httpError"; status: number }
  /** A CLI provider whose binary is not on this machine. */
  | { kind: "cliNotFound"; bin: string };

/**
 * Open a throwaway MQTT-over-WSS connection and close it again. Resolves
 * `"connected"` once the broker sends CONNACK, `"error"` on a refused/failed
 * connection, a non-`ws(s)://` URL (unreachable from any browser), or timeout.
 */
export async function probeBroker(broker: MqttBrokerConfig): Promise<ConnectionStatus> {
  if (!isBrowserReachableBroker(broker.url)) return "error";

  return new Promise<ConnectionStatus>((resolve) => {
    const client = mqtt.connect(broker.url, {
      clientId: `microflow-probe-${Math.random().toString(16).slice(2, 10)}`,
      username: broker.username || undefined,
      password: broker.password || undefined,
      // One shot: a probe that silently retries would keep a socket open for the
      // life of the page and report a status nobody asked to refresh.
      reconnectPeriod: 0,
      connectTimeout: PROBE_TIMEOUT_MS,
    });
    const settle = (status: ConnectionStatus) => {
      clearTimeout(timer);
      client.end(true);
      resolve(status);
    };
    const timer = setTimeout(() => settle("error"), PROBE_TIMEOUT_MS);
    client.on("connect", () => settle("connected"));
    client.on("error", () => settle("error"));
  });
}

/**
 * Probe an LLM provider's model list — the cheapest endpoint that proves this
 * page can actually reach it.
 *
 * Since ADR-0021 this runs in BOTH hosts, over the same `hostFetch` the real
 * transport uses, so a green dot here means the `Llm` node will work: on desktop
 * the request goes through the Tauri HTTP plugin exactly as a generation does.
 *
 * In the browser it is also where the browser-only blockers surface — an
 * `http://localhost` provider on an https page (mixed content) and a provider
 * that does not allow this origin (CORS) both fail here, where the desktop app
 * succeeds. That difference is real and worth showing.
 */
export async function probeLlmProvider(
  provider: LlmProviderConfig,
  fetchImpl?: typeof fetch,
): Promise<LlmProbeOutcome> {
  // A local CLI has no endpoint to reach — "reachable" can only mean the
  // binary is installed, which is exactly what `llm_cli_probe` answers.
  if (provider.kind === "cli") {
    const { invokeCommand } = await import("@/lib/ipc");
    const response = await invokeCommand<{ type: "llm_cli_probe"; bin: string }, Record<string, unknown>>({
      type: "llm_cli_probe",
      bin: provider.baseUrl,
    });
    return response.success ? { kind: "ok" } : { kind: "cliNotFound", bin: provider.baseUrl };
  }

  // Blocked by the browser before any request leaves, so there is nothing to
  // learn from attempting it — and a `TypeError` here would be indistinguishable
  // from a CORS refusal.
  if (isMixedContent(provider.baseUrl)) return { kind: "mixedContent" };

  const url = `${normalizeBaseUrl(provider.baseUrl)}/models`;

  const headers: Record<string, string> = {};
  if (provider.apiKey.length > 0) headers.authorization = `Bearer ${provider.apiKey}`;
  try {
    const doFetch = fetchImpl ?? (await hostFetch());
    const response = await doFetch(url, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // It answered. A non-2xx is a *reached* endpoint rejecting us — a bad key,
    // a wrong path — which is a different fix from not reaching it at all.
    return response.ok ? { kind: "ok" } : { kind: "httpError", status: response.status };
  } catch {
    // `fetch` rejects identically for a CORS refusal, DNS failure, connection
    // refused and timeout: the browser deliberately withholds which. This is
    // the honest limit of what the probe can know, and it is still one step
    // better than the caller re-deriving it from the URL.
    return { kind: "unreachable" };
  }
}

/** `true` when the probe reached a working endpoint. */
export function isProbeOk(outcome: LlmProbeOutcome): boolean {
  return outcome.kind === "ok";
}

/** Map a probe outcome onto the coarse status the config store renders as a dot. */
export function probeStatus(outcome: LlmProbeOutcome): ProviderStatus {
  return isProbeOk(outcome) ? "ok" : "error";
}
