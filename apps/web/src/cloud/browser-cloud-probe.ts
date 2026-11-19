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

import mqtt, { type MqttClient } from "mqtt";
import type { ConnectionStatus, MqttBrokerConfig } from "@/cloud/mqtt-broker";
import type { LlmProviderConfig, ProviderStatus } from "@/ai/llm-provider";
import { isBrowserReachableBroker } from "@/cloud/broker-url";
import { brokerProblem } from "@/cloud/mqtt-refusal";
import { hostFetch, isMixedContent, normalizeBaseUrl } from "@/ai/endpoint";

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

/** How a broker probe ended: the status to show, and why it is `error` when
 *  that is something the user can act on (`mqtt-refusal.ts`). */
export type BrokerProbe = { status: ConnectionStatus; problem?: string };

/**
 * Open a throwaway MQTT-over-WSS connection and close it again, speaking MQTT 5
 * as a flow's connections do (`mqtt-client.ts`), so the status says whether a
 * flow can reach the broker. Resolves `"connected"` once the broker sends
 * CONNACK, `"error"` on a refused/failed connection, a non-`ws(s)://` URL
 * (unreachable from any browser), a URL no connection can be opened to
 * (`mqtt.connect` throws on a space or an impossible port), or timeout. A
 * broker that refused the connection for its protocol version comes with the
 * problem that says so. It never rejects.
 *
 * `connect` is `mqtt.connect`; a test passes its own.
 */
export async function probeBroker(
  broker: MqttBrokerConfig,
  connect: typeof mqtt.connect = mqtt.connect,
): Promise<BrokerProbe> {
  if (!isBrowserReachableBroker(broker.url)) return { status: "error" };

  let client: MqttClient;
  try {
    client = connect(broker.url, {
      protocolVersion: 5,
      clientId: `microflow-probe-${Math.random().toString(16).slice(2, 10)}`,
      username: broker.username || undefined,
      password: broker.password || undefined,
      // One shot: a probe that silently retries would keep a socket open for the
      // life of the page and report a status nobody asked to refresh.
      reconnectPeriod: 0,
      connectTimeout: PROBE_TIMEOUT_MS,
    });
  } catch {
    return { status: "error" };
  }

  return new Promise<BrokerProbe>((resolve) => {
    let settled = false;
    const settle = (probe: BrokerProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end(true);
      resolve(probe);
    };
    const timer = setTimeout(() => settle({ status: "error" }), PROBE_TIMEOUT_MS);
    client.on("connect", () => settle({ status: "connected" }));
    client.on("error", (error) => settle({ status: "error", problem: brokerProblem(error) }));
    // A broker that closes the connection without a CONNACK says nothing
    // about why, and `mqtt.js` emits no error for it: it is an error all the
    // same, and one without a problem to tell.
    client.on("close", () => settle({ status: "error" }));
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
    const { invokeCommand } = await import("@/platform/ipc");
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
