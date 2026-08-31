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
import { hostFetch, normalizeBaseUrl } from "@/lib/ai/endpoint";

const PROBE_TIMEOUT_MS = 8000;

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
): Promise<ProviderStatus> {
  const url = `${normalizeBaseUrl(provider.baseUrl)}/models`;

  const headers: Record<string, string> = {};
  if (provider.apiKey.length > 0) headers.authorization = `Bearer ${provider.apiKey}`;
  try {
    const doFetch = fetchImpl ?? (await hostFetch());
    const response = await doFetch(url, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}
