// The parts of talking to an LLM endpoint that carry no SDK: which `fetch` to
// use, and where the API root is.
//
// Split out of `adapter.ts` for one concrete reason — the config page's
// reachability probe (`session/browser-cloud-probe.ts`) needs exactly these two
// and is loaded on every page. Importing them from `adapter.ts` dragged
// `@tanstack/ai` and the OpenAI client into the main bundle for users who never
// touch an LLM. Keep this module free of SDK imports.

import { isDesktop } from "@/lib/platform";

let cachedFetch: typeof fetch | undefined;

/**
 * The `fetch` the adapter runs on.
 *
 * In the browser: the page's own `fetch`, a direct call with the user's own key
 * (ADR-0009 D4). In the desktop webview: `@tauri-apps/plugin-http`'s `fetch`,
 * which performs the request in Rust.
 *
 * That swap is the whole reason the desktop can share this code. A webview
 * `fetch` runs from the `tauri.localhost` origin and is subject to CORS, which
 * is exactly what a laptop-local Ollama or LM Studio rejects — the original
 * reason desktop had a separate reqwest transport at all. Going through the
 * plugin has no origin and no preflight, so one implementation serves both
 * hosts without either giving anything up.
 *
 * The plugin only calls URLs inside the `http:default` scope in
 * `capabilities/default.json`. That scope needs an explicit `*` port
 * (`http://*:*`) — `http://*` matches port 80 only, which silently blocks every
 * localhost Ollama / LM Studio.
 *
 * Resolved lazily and cached: importing the Tauri plugin eagerly would pull it
 * into the web bundle for a code path the browser never takes.
 */
export async function hostFetch(): Promise<typeof fetch> {
  if (cachedFetch) return cachedFetch;
  if (!isDesktop()) {
    cachedFetch = globalThis.fetch.bind(globalThis);
    return cachedFetch;
  }
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  cachedFetch = tauriFetch as unknown as typeof fetch;
  return cachedFetch;
}

/** Reset the memoised host `fetch`. Tests only. */
export function resetHostFetch(): void {
  cachedFetch = undefined;
}

/**
 * Normalise a stored base URL to the API root the adapter wants.
 *
 * Providers saved before ADR-0021 have no `/v1` — the old hand-rolled client
 * appended `/v1/chat/completions` itself — while the settings page's OpenAI and
 * OpenRouter presets ship one. Both must keep working, so accept either.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * An `http://` endpoint on an `https://` page: the browser blocks the request
 * before it goes out, and nothing on our side can fix it.
 *
 * Lives here because it is a property of how *this page* reaches an endpoint,
 * like `hostFetch` — the probe needs it to classify a failure, and the config
 * page needs it to warn before anyone presses Test. Always false in the desktop
 * webview, which fetches through the Tauri plugin rather than the page.
 */
export function isMixedContent(baseUrl: string): boolean {
  return (
    !isDesktop() &&
    typeof window !== "undefined" &&
    window.location.protocol === "https:" &&
    baseUrl.trim().toLowerCase().startsWith("http://")
  );
}

