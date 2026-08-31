// Browser reachability probes for the cloud config pages.
//
// The desktop host owns live connections and pushes their state back as
// "mqtt-broker-status" / an `llm_test_provider` result, which is what fills the
// status dots on /configuration/{mqtt,llm}. The browser has no such host: its
// connections are opened lazily by the CloudPerformer when a flow needs them, so
// nothing ever set a status and every broker/provider read as "never connected".
//
// These are that missing feedback channel — a short-lived probe per config entry,
// answering only "is this endpoint reachable from THIS page?". They never touch
// the runtime's own connections.

import mqtt from "mqtt";
import type { ConnectionStatus, MqttBrokerConfig } from "@/stores/mqtt-broker";
import type { LlmProviderConfig, ProviderStatus } from "@/stores/llm-provider";
import { isBrowserReachableBroker } from "@/components/flow/nodes/_base/browser-support";

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
 * GET the provider's `/v1/models` — the cheapest OpenAI-compatible endpoint that
 * proves the browser can actually reach it. This is also where a browser-only
 * blocker surfaces: an `http://localhost` provider on an https page (mixed
 * content) and a provider that doesn't allow this origin (CORS) both fail here,
 * where the desktop app succeeds.
 */
export async function probeLlmProvider(
  provider: LlmProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderStatus> {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (provider.apiKey.length > 0) headers.authorization = `Bearer ${provider.apiKey}`;
  try {
    const response = await fetchImpl(`${base}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}
